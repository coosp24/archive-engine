import { createBatchSaver } from "../../core/batch-saver.js";
import { describeCounts, isDev, line } from "../../core/log.js";
import { mapLimit } from "../../core/pool.js";
import { retry, wait } from "../../core/retry.js";
import { facesStore } from "../../db/faces.js";
import { createApi } from "./api.js";
import { mergeModel, shapeListed, shapeOperator, shapeProfile, shapeStory } from "./model.js";
import { getCurrentStories, recordModels } from "./store.js";

// flirtify (flirtify.com): its stories, its models' profiles, and what its
// category pages say of them, read as a guest with no browser, and saved to
// its own tables (./store.js, supabase/flirtify/).
//
// Its stories feed holds one story per model, her newest — so it's the list
// of its models too (~5,400). Each one's profile is read for the rest of her
// stories and what she says of herself, and the category pages by age for
// her age bracket and country, which her profile hides. Every link to a
// picture or video expires two days after it's given out, so every run saves
// fresh ones for everything it reads.

// The stories feed: at most 36 a page, stable and not overlapping. A pause
// between pages keeps it gentle.
const FEED_PAGE = 36;
const PAGE_DELAY = 150;
// Those streaming now: a few dozen at most.
const ROOMS_PAGE = 36;
// The category pages by age, 12 models a page, each with her age bracket's
// youngest age as the archive keeps it. Every model with an age is in one,
// and each comes with her country. Their order shifts while they're read,
// so one pass sees ~75% of a category; it's read once a run, not again until
// all of it's been seen (three passes took ~15 minutes, most of a run). Age
// bracket and country hardly change, and what a run misses the archive keeps
// from the runs before, so whoever one pass misses is seen within an hour or
// two.
const AGE_GROUPS = { 18: 18, 20: 20, 30: 30, 40: 40, "over-50": 50 };
const CATEGORY_PAGE = 12;
const CATEGORY_MAX_PAGES = 1000;
const CATEGORY_PASSES = 1;
// Profiles read at once.
const PROFILE_CONCURRENCY = 6;
// A profile is read every run for a model who has posted since (her feed
// story isn't her current one in the archive) or who's new; everyone else's
// in turn, a share of them each hour, so each is read at least every
// PROFILE_EVERY_HOURS. Her links last two days, so that keeps them fresh,
// and what else a profile says rarely changes within hours. (Reading every
// profile every run took ~25 of a run's ~27 minutes.)
const PROFILE_EVERY_HOURS = 6;

// Which hour of PROFILE_EVERY_HOURS a model's profile is read in: from her
// id, so it's the same every day.
function profileTurn(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % PROFILE_EVERY_HOURS;
}

// A request tried again when it fails — a timeout, a 5xx, or flirtify
// asking for a pause (429) — not when it's answered with something else.
const attempt = (fn) => retry(fn, { attempts: 4, delayMs: 3000 });
const busy = (status) => status === 429 || status >= 500;

// The feed, every story in it once, as flirtify sends them; stops early at
// `limit` stories.
async function readFeed(api, limit) {
  const stories = new Map();
  let total = Infinity;
  for (let offset = 0; offset < total; offset += FEED_PAGE) {
    const res = await attempt(async () => {
      const r = await api.json(`/story/feed?offset=${offset}&limit=${FEED_PAGE}`);
      if (busy(r.status)) throw new Error(`HTTP ${r.status}`);
      return r;
    });
    if (!res.ok) throw new Error(`flirtify's feed answered HTTP ${res.status}: ${res.json?.message ?? ""}`.trim());
    const list = res.json?.items ?? [];
    total = res.json?.count ?? 0;
    for (const s of list) if (s?.id && !stories.has(s.id)) stories.set(s.id, s);
    if (isDev) console.log(`📄 Feed from ${offset}: ${list.length} stories (${stories.size} of ${total})`);
    if (!list.length || (limit && stories.size >= limit)) break;
    await wait(PAGE_DELAY);
  }
  return [...stories.values()].slice(0, limit ?? undefined);
}

// The models streaming now, by id. A failure leaves them out rather than
// failing the run.
async function readLive(api) {
  const live = new Map();
  try {
    for (let offset = 0; ; offset += ROOMS_PAGE) {
      const res = await api.json(`/room/feed?offset=${offset}&limit=${ROOMS_PAGE}`);
      const list = res.json?.items ?? [];
      for (const r of list) {
        if (r?.userId) live.set(r.userId, { id: r.userId, username: r.username, displayName: r.displayName, isOnline: true });
      }
      if (list.length < ROOMS_PAGE) break;
    }
  } catch (error) {
    console.warn(`⚠️ Couldn't read who's streaming (${error.message})`);
  }
  return live;
}

// One of flirtify's pages' data ({ data } or { error }), tried again while
// flirtify is busy.
const readPage = (api, path) =>
  attempt(async () => {
    const r = await api.page(path);
    if (busy(r.error?.status)) throw new Error(r.error.message);
    return r;
  });

// Every model in flirtify's age categories, by id: { listed, ageGroup }. A
// category that fails partway keeps what it read.
async function readCategories(api) {
  const models = new Map();
  await mapLimit(Object.entries(AGE_GROUPS), 5, async ([slug, ageGroup]) => {
    let seen = 0;
    let total = Infinity;
    try {
      for (let pass = 1; pass <= CATEGORY_PASSES && seen < total; pass++) {
        for (let page = 1; page <= CATEGORY_MAX_PAGES; page++) {
          const { data, error } = await readPage(api, `/categories/${slug}?page=${page}`);
          // Past the last page is a 404.
          if (error) {
            if (error.status === 404 && page > 1) break;
            throw new Error(error.message);
          }
          const items = data?.items ?? [];
          total = data?.count ?? 0;
          for (const item of items) {
            const listed = shapeListed(item);
            if (!listed.modelId) continue;
            if (models.get(listed.modelId)?.ageGroup !== ageGroup) seen++;
            models.set(listed.modelId, { listed, ageGroup });
          }
          if (items.length < CATEGORY_PAGE || page * CATEGORY_PAGE >= total) break;
          await wait(PAGE_DELAY);
        }
        if (isDev) console.log(`📂 "${slug}", pass ${pass}: ${seen} of ${total}`);
      }
    } catch (error) {
      console.warn(`⚠️ Couldn't read all of flirtify's "${slug}" category (${error.message})`);
    }
  });
  return models;
}

// Her profile, shaped (./model.js): { profile }, or { gone: true } when
// flirtify has none for her (a 404), or {} when it can't be read just now.
// It's at /profile/<username>, or /profile/<her number> for a model with no
// username.
async function readProfile(api, { username, intId }) {
  const handle = username ?? (intId === null ? null : String(intId));
  if (!handle) return {};
  try {
    const { data, error } = await readPage(api, `/profile/${encodeURIComponent(handle)}`);
    if (error) return error.status === 404 ? { gone: true } : {};
    return data?.profile ? { profile: shapeProfile(data.profile) } : {};
  } catch {
    return {};
  }
}

// Reads flirtify's feed (or `limit` stories of it, and then only their
// models), who's streaming, its age categories and every model's profile,
// and saves them all: new ones added, the rest brought up to date with fresh
// links, each model marked seen. Fills `report` in as it goes.
async function archive({ account, limit, report }) {
  const api = createApi();
  try {
    if (account) console.log("👤 flirtify is read as a guest: it shows a guest everything the archive keeps");
    report.guest = true;

    const feed = await readFeed(api, limit);
    const live = await readLive(api);
    // A trial run of `limit` stories skips the ~420 category pages.
    const categories = limit ? new Map() : await readCategories(api);

    // Every model: the feed's, then (unless it's a trial run) those only in
    // the categories or streaming.
    const models = new Map();
    for (const s of feed) {
      const operator = shapeOperator(s.operator);
      if (operator.modelId) models.set(operator.modelId, { feed: operator, story: shapeStory(s) });
    }
    if (!limit) {
      for (const [id, { listed }] of categories) if (!models.has(id)) models.set(id, { feed: listed });
      for (const [id, o] of live) if (!models.has(id)) models.set(id, { feed: shapeOperator(o) });
    }

    const entries = [...models.entries()];
    // Whose profile this run reads (see PROFILE_EVERY_HOURS): every one on a
    // trial run, which has only a few.
    const current = limit ? null : await getCurrentStories();
    const turn = Math.floor(Date.now() / 3_600_000) % PROFILE_EVERY_HOURS;
    const needsProfile = ([id, m]) =>
      !current ||
      !current.has(id) ||
      (m.story?.storyId != null && m.story.storyId !== current.get(id)) ||
      profileTurn(id) === turn;
    let profilesRead = 0;
    const profiles = await mapLimit(entries, PROFILE_CONCURRENCY, (entry) => {
      if (!needsProfile(entry)) return { skipped: true };
      profilesRead++;
      return readProfile(api, entry[1].feed);
    });

    const saver = createBatchSaver({ send: recordModels, describe: describeCounts, batchSize: 50 });
    const online = new Set();
    const stories = new Set();
    let unsaveable = 0;
    let gone = 0;
    let unread = 0;
    let moreStories = 0;
    for (const [i, [id, m]] of entries.entries()) {
      const { profile = null, gone: isGone, skipped } = profiles[i];
      if (isGone) gone++;
      else if (!profile && !skipped) unread++;
      if (profile?.moreStories) moreStories++;
      const record = mergeModel({
        ...m,
        profile,
        listed: categories.get(id)?.listed ?? null,
        ageGroup: categories.get(id)?.ageGroup ?? null,
        live: live.has(id),
      });
      if (!record.modelId) {
        unsaveable++;
        continue;
      }
      if (record.online) online.add(id);
      for (const s of record.stories) stories.add(s.storyId);
      saver.queue(record);
      if (isDev) {
        line();
        console.log(`👤 ${record.name ?? "unknown"} — ${record.modelId} / ${record.username}`);
        console.log(`🌍 ${record.country ?? "?"}, ${record.ageGroup ?? "?"}+ · ${record.languages?.join(", ") ?? "no languages"}`);
        console.log(`🎬 ${record.stories.length} stories · 🟢 ${record.online ? "online" : "offline"}${live.has(id) ? " (streaming)" : ""}`);
      }
    }
    await saver.flush();

    const { stats, added } = saver;
    Object.assign(report, {
      storiesFound: stories.size,
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
    console.log(`🎞️  Stories found:   ${stories.size} (${feed.length} in the feed)`);
    console.log(`👥 Models:          ${models.size} (${categories.size} in the age categories, ${live.size} streaming)`);
    console.log(`📇 Profiles read:   ${profilesRead} (new, posted since, or their turn: each every ${PROFILE_EVERY_HOURS}h)`);
    console.log(`💾 Saved:           ${stats.saved} models (every one: her links expire)`);
    console.log(`🆕 New models:      ${report.newModels}`);
    console.log(`🆕 New stories:     ${report.newStories}`);
    console.log(`🆕 New names:       ${report.newNames}`);
    console.log(`🆕 New avatars:     ${report.newAvatars}`);
    console.log(`🟢 Online:          ${online.size} models`);
    if (gone) console.log(`👻 No profile:      ${gone} models (gone from flirtify)`);
    if (unread) console.log(`⚠️  Profiles unread: ${unread} — tried again next run`);
    if (moreStories) console.log(`⚠️  More stories:    ${moreStories} models have more than their profile lists`);
    console.log(`⚠️  Failed to save:  ${report.failedSaves}`);
  } finally {
    report.dataMB = api.megabytes();
  }
}

// The site, as src/sites/index.js lists it (see there for what a site is).
export default {
  id: "flirtify",
  method: "api",
  browser: false,
  archive,
  faces: facesStore("flirtify"),
};
