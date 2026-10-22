import { createBatchSaver } from "../../core/batch-saver.js";
import { isDev, line } from "../../core/log.js";
import { wait } from "../../core/retry.js";
import { createApi } from "./api.js";
import { getKnownAvatars, recordStories } from "./store.js";
import { fullAvatarCandidates, shapeStory } from "./story.js";

// flirtbees (flirtbees.com): its public stories, read from its API with no
// browser, and saved to its own tables (./store.js, supabase/flirtbees/).

// The feed comes back shuffled, 40 stories a page whatever the limit asked
// for, with pages overlapping — so it's read until this many pages in a row
// bring nothing new (about a dozen pages reach every story, ~125 of them),
// or MAX_PAGES. A pause between pages keeps it gentle.
const QUIET_PAGES = 4;
const MAX_PAGES = 60;
const PAGE_DELAY = 500;

const PLURAL = { model: "models", name: "names", avatar: "avatars", story: "stories" };
const describe = (counts) =>
  Object.entries(counts)
    .filter(([, n]) => n)
    .map(([kind, n]) => `${n} ${n === 1 ? kind : (PLURAL[kind] ?? kind)}`)
    .join(", ");

// The feed, every story in it once, as flirtbees sends them; stops early at
// `limit` stories. A guest is only shown about ten, then refused (403).
async function readFeed(api, limit) {
  const stories = new Map();
  let quiet = 0;
  for (let page = 1; page <= MAX_PAGES && quiet < QUIET_PAGES; page++) {
    const res = await api.get(`/stories/public?limit=20&page=${page}`);
    if (res.status === 403 && stories.size) {
      console.log(`🚧 flirtbees stopped showing stories after ${stories.size} (a guest's limit)`);
      break;
    }
    if (!res.ok) throw new Error(`flirtbees' feed answered HTTP ${res.status}: ${res.json?.message ?? ""}`.trim());
    const list = res.json?.data?.stories ?? [];
    if (!list.length) break;
    const before = stories.size;
    for (const s of list) if (!stories.has(String(s.id))) stories.set(String(s.id), s);
    quiet = stories.size > before ? 0 : quiet + 1;
    if (isDev) console.log(`📄 Page ${page}: ${list.length} stories, ${stories.size - before} new (${stories.size} so far)`);
    if (limit && stories.size >= limit) break;
    await wait(PAGE_DELAY);
  }
  return [...stories.values()].slice(0, limit ?? undefined);
}

// Her full-size avatar (see fullAvatarCandidates): the one the archive has
// when it's the same picture, else the first address that answers; null for
// the placeholder, or when none does.
async function fullAvatar(api, story, known) {
  const candidates = fullAvatarCandidates(story.avatarSmall);
  if (!candidates.length) return null;
  const kept = known.get(story.modelId);
  if (kept && candidates.includes(kept)) return kept;
  for (const url of candidates) {
    if (await api.exists(url)) {
      known.set(story.modelId, url);
      return url;
    }
  }
  return null;
}

// Reads flirtbees' public stories (or `limit` of them) and saves them all:
// new ones added, the rest brought up to date (likes, points, online), each
// model marked seen. Fills `report` in as it goes.
async function archive({ account, limit, report }) {
  const api = createApi();
  try {
    if (account) console.log(`🔑 Logging in as ${account.email}`);
    report.guest = !(await api.signIn(account));

    const raw = await readFeed(api, limit);
    const known = await getKnownAvatars();
    const saver = createBatchSaver({ send: recordStories, describe });
    const online = new Set();
    let unsaveable = 0;

    for (const [i, item] of raw.entries()) {
      const story = shapeStory(item);
      if (!story.modelId || !story.modelUid || !story.storyId || !story.src) {
        unsaveable++;
        continue;
      }
      story.avatar = await fullAvatar(api, story, known);
      if (story.online) online.add(story.modelId);
      saver.queue(story);
      if (isDev) {
        line();
        console.log(`🎬 Story ${i + 1}: ${story.storyId} (${story.storyUid}), published ${story.published}`);
        console.log(`👤 ${story.name ?? "unknown"} — ${story.modelId} / ${story.modelUid}`);
        console.log(`🖼️  Avatar: ${story.avatar ?? "none"}`);
        console.log(`❤️  ${story.likes} likes, ${story.points} points · 🟢 ${story.online ? "online" : "offline"}`);
      }
    }
    await saver.flush();

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
    console.log(`🎞️  Stories found:   ${raw.length}`);
    console.log(`💾 Saved:           ${stats.saved} (every story: likes and points change)`);
    console.log(`🆕 New models:      ${report.newModels}`);
    console.log(`🆕 New stories:     ${report.newStories}`);
    console.log(`🆕 New names:       ${report.newNames}`);
    console.log(`🆕 New avatars:     ${report.newAvatars}`);
    console.log(`🟢 Online:          ${online.size} models`);
    console.log(`⚠️  Failed to save:  ${report.failedSaves}`);
  } finally {
    report.dataMB = api.megabytes();
  }
}

// The site, as src/sites/index.js lists it (see there for what a site is).
export default {
  id: "flirtbees",
  method: "api",
  browser: false,
  archive,
  faces: null,
};
