import { createBatchSaver } from "../../core/batch-saver.js";
import { isDev, line } from "../../core/log.js";
import { mapLimit } from "../../core/pool.js";
import { wait } from "../../core/retry.js";
import { facesStore } from "../../db/faces.js";
import { createApi } from "./api.js";
import { mergeGirl, shapeInfo, shapePhoto, shapeReel } from "./girl.js";
import { recordPhotos, recordStories } from "./store.js";

// mirami (mirami.chat): its reels — its stories — read from its API as a
// guest, with no browser, and saved to its own tables (./store.js,
// supabase/mirami/). The models are the girls with reels; each one's
// profile is read too, for what the reels don't say, and her gallery: every
// photo on her profile.

// The reels feed: 100 a page, the pages stable and not overlapping (~2,200
// reels in ~23 pages). Read until a page is empty or brings nothing new, or
// MAX_PAGES. A pause between pages keeps it gentle.
const PER_PAGE = 100;
const MAX_PAGES = 100;
const PAGE_DELAY = 300;
// mirami's girls lists, the only place with her shows count: those online
// now, and the directory — of which a guest (or an account) is shown only
// the first 10 pages.
const LIST_PER_PAGE = 40;
const LIST_PAGES = 10;
// Profiles (and galleries) read at once.
const PROFILE_CONCURRENCY = 6;
// A gallery's pages: 20 photos each (her avatar besides, on the first),
// whatever's asked for; the most seen is 6. A cap all the same.
const GALLERY_PAGES = 30;

const PLURAL = { model: "models", name: "names", avatar: "avatars", story: "reels" };
const describe = (counts) =>
  Object.entries(counts)
    .filter(([, n]) => n)
    .map(([kind, n]) => `${n} ${n === 1 ? (kind === "story" ? "reel" : kind) : (PLURAL[kind] ?? kind)}`)
    .join(", ");

// The feed, every reel in it once, as mirami sends them; stops early at
// `limit` reels.
async function readReels(api, limit) {
  const reels = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await api.get(`/v2/gallery/media/video/shorts?per-page=${PER_PAGE}&page=${page}`);
    if (!res.ok) throw new Error(`mirami's reels answered HTTP ${res.status}: ${res.json?.message ?? ""}`.trim());
    const list = res.json?.data ?? [];
    const before = reels.size;
    for (const r of list) if (!reels.has(String(r.id))) reels.set(String(r.id), r);
    if (isDev) console.log(`📄 Page ${page}: ${list.length} reels, ${reels.size - before} new (${reels.size} so far)`);
    if (!list.length || reels.size === before) break;
    if (limit && reels.size >= limit) break;
    await wait(PAGE_DELAY);
  }
  return [...reels.values()].slice(0, limit ?? undefined);
}

// The girls in mirami's lists this run, by id: those online now and the
// directory's first pages. Only for their shows counts, so a list that
// fails is left out rather than failing the run.
async function readListed(api) {
  const listed = new Map();
  const add = (list) => list?.forEach((g) => g?.id != null && listed.set(String(g.id), g));
  try {
    add((await api.get("/girls/online")).json?.data);
    for (let page = 1; page <= LIST_PAGES; page++) {
      const res = await api.get(`/girls?per-page=${LIST_PER_PAGE}&page=${page}`);
      if (!res.ok || !res.json?.data?.length) break;
      add(res.json.data);
      await wait(PAGE_DELAY);
    }
  } catch (error) {
    console.warn(`⚠️ Couldn't read mirami's girls lists (${error.message}) — no shows counts this run`);
  }
  return listed;
}

// Her profile, shaped (./girl.js); null when mirami has none for her (a
// 404: her account is gone, though her reels aren't yet) or it can't be
// read just now.
async function readProfile(api, refCode) {
  if (!refCode) return null;
  try {
    const res = await api.get(`/girl_info?ref_code=${encodeURIComponent(refCode)}`);
    return res.ok && res.json ? shapeInfo(res.json) : null;
  } catch {
    return null;
  }
}

// Every photo in her gallery, shaped (./girl.js); null when it can't be
// read just now (and it's left as the archive has it).
async function readGallery(api, modelId) {
  const photos = [];
  try {
    for (let page = 1; page <= GALLERY_PAGES; page++) {
      const res = await api.get(`/gallery?page=${page}&user_id=${modelId}&ignore_self_gallery=1`);
      if (!res.ok) return page === 1 ? null : photos;
      const list = res.json?.data ?? [];
      photos.push(...list.map((p) => shapePhoto(p, modelId)).filter((p) => p.id));
      if (!list.length || page >= Number(res.json?.total_pages ?? 1)) break;
    }
    return photos;
  } catch {
    return null;
  }
}

// Reads mirami's reels (or `limit` of them) and every one of their girls'
// profiles and galleries, and saves them all: new ones added, the rest
// brought up to date (likes, counts, online), each girl marked seen. Fills
// `report` in as it goes.
async function archive({ account, limit, report }) {
  const api = createApi();
  try {
    if (account) console.log("👤 mirami is read as a guest: an account sees no more there");
    await api.signIn();
    report.guest = true;

    const raw = await readReels(api, limit);
    const reels = raw.map(shapeReel);
    const listed = await readListed(api);

    // One profile per girl, however many reels she has.
    const girls = [...new Map(reels.filter((r) => r.modelId).map((r) => [r.modelId, r.refCode])).entries()];
    const infos = new Map(
      await mapLimit(girls, PROFILE_CONCURRENCY, async ([modelId, refCode]) => [modelId, await readProfile(api, refCode)]),
    );
    const noProfile = [...infos.values()].filter((info) => !info).length;

    const saver = createBatchSaver({ send: recordStories, describe });
    const online = new Set();
    let unsaveable = 0;
    for (const [i, reel] of reels.entries()) {
      if (!reel.modelId || !reel.storyId || !reel.src) {
        unsaveable++;
        continue;
      }
      const record = mergeGirl(reel, infos.get(reel.modelId), listed.get(reel.modelId));
      if (record.online) online.add(record.modelId);
      saver.queue(record);
      if (isDev) {
        line();
        console.log(`🎬 Reel ${i + 1}: ${record.storyId}`);
        console.log(`👤 ${record.name ?? "unknown"} — ${record.modelId} / ${record.refCode}`);
        console.log(`🖼️  Avatar: ${record.avatar ?? "none"}`);
        console.log(`❤️  ${record.likes} likes · 🟢 ${record.online ? "online" : "offline"}`);
      }
    }
    await saver.flush();

    // Her photos, once her row is saved (a photo points at it).
    const galleries = await mapLimit(girls, PROFILE_CONCURRENCY, ([modelId]) => readGallery(api, modelId));
    const photos = galleries.flatMap((g) => g ?? []);
    const photoSaver = createBatchSaver({ send: recordPhotos, describe: ({ photo }) => `${photo} photos`, batchSize: 500 });
    photos.forEach((photo) => photoSaver.queue(photo));
    await photoSaver.flush();
    const unreadGalleries = galleries.filter((g) => !g).length;

    const { stats, added } = saver;
    Object.assign(report, {
      storiesFound: raw.length,
      ownerUnknown: unsaveable,
      saved: stats.saved,
      skipped: 0,
      failedSaves: stats.failed + unsaveable,
      newModels: added.model ?? 0,
      newStories: added.story ?? 0,
      newNames: added.name ?? 0,
      newAvatars: added.avatar ?? 0,
    });
    line();
    console.log(`🎞️  Reels found:     ${raw.length}, from ${girls.length} models`);
    console.log(`💾 Saved:           ${stats.saved} (every reel: likes and counts change)`);
    console.log(`🆕 New models:      ${report.newModels}`);
    console.log(`🆕 New reels:       ${report.newStories}`);
    console.log(`🆕 New names:       ${report.newNames}`);
    console.log(`🆕 New avatars:     ${report.newAvatars}`);
    console.log(`📷 Photos:          ${photos.length} (${photos.filter((p) => p.premium).length} Premium only), ${photoSaver.added.photo ?? 0} new`);
    if (unreadGalleries) console.log(`⚠️  Galleries unread: ${unreadGalleries} — tried again next run`);
    if (photoSaver.stats.failed) console.log(`⚠️  Photos not saved: ${photoSaver.stats.failed}`);
    console.log(`🟢 Online:          ${online.size} models`);
    if (noProfile) console.log(`👻 No profile:      ${noProfile} models (gone from mirami, or unreadable just now)`);
    console.log(`⚠️  Failed to save:  ${report.failedSaves}`);
  } finally {
    report.dataMB = api.megabytes();
  }
}

// The site, as src/sites/index.js lists it (see there for what a site is).
export default {
  id: "mirami",
  method: "api",
  browser: false,
  archive,
  faces: facesStore("mirami"),
};
