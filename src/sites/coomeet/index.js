import { readFile } from "node:fs/promises";
import { facesStore } from "../../db/faces.js";
import { isDev, line } from "../../core/log.js";
import { retry, wait } from "../../core/retry.js";
import { createStorySaver } from "./saver.js";
import { login, passIntro } from "./session.js";
import { getKnownModels, recordStories } from "./store.js";
import { shapeStory } from "./story.js";

// coomeet (p.coomeet.com): its stories feed, read straight from its server
// over the app's own websocket (./feed.page.js), and saved to its own
// tables (./store.js, supabase/coomeet/).

// The app is opened on its dialog page, where it doesn't load stories
// itself, and where the login form's selectors are known to work.
const APP_URL = "https://p.coomeet.com/dialog";

// How long coomeet's connection gets to open after the page loads, and how
// many times the page is reloaded and waited on again when it doesn't (it
// has failed for the archive and cooscrap-engine in the same minute, so
// it's coomeet's side).
const FEED_READY_TIMEOUT = 20000;
const FEED_READY_ATTEMPTS = 3;
const FEED_RETRY_DELAY = 10000;
// How long a batch request gets (~0.3s normally). Now and then coomeet
// lets one go unanswered; asked again a few seconds later, it answers.
const BATCH_TIMEOUT = 5000;
const BATCH_ATTEMPTS = 6;
// How many batches in a row of only stories already seen end the feed.
const STALE_BATCHES = 8;
// Models asked for their story at once, and how long each answer gets.
// 25 at a time asked all ~19k in ~2.5 minutes, coomeet never slowing.
const AUTHOR_CONCURRENCY = 25;
const AUTHOR_TIMEOUT = 10000;

const FEED_SCRIPT = await readFile(new URL("./feed.page.js", import.meta.url), "utf8");

// Waits for coomeet's connection to open and be authorized, reloading the
// page while it doesn't. Each attempt first gets past the intro screens, in
// case they're showing again.
async function waitForFeed(page) {
  for (let attempt = 1; ; attempt++) {
    await passIntro(page);
    try {
      await page.waitForFunction(() => window.__cooscrap.feedReady(), { timeout: FEED_READY_TIMEOUT });
      return;
    } catch {
      const status = await page
        .evaluate(() => window.__cooscrap.socketStatus())
        .catch(() => "the page didn't answer");
      if (attempt >= FEED_READY_ATTEMPTS) throw new Error(`coomeet's connection didn't open — ${status}`);
      console.warn(`⚠️ coomeet's connection didn't open (${status}) — reloading (${attempt}/${FEED_READY_ATTEMPTS - 1})`);
      await wait(FEED_RETRY_DELAY);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
}

// The next batch, marking `toLook` viewed first; asked for again while
// coomeet doesn't answer. Sending the same looks again on a retry is
// harmless.
async function nextBatch(page, toLook) {
  const batch = await retry(
    async () => {
      const reply = await page.evaluate(
        (look, timeout) => window.__cooscrap.nextBatch(look, timeout),
        toLook,
        BATCH_TIMEOUT,
      );
      if (reply.error && reply.retry) throw new Error(reply.error);
      return reply;
    },
    {
      attempts: BATCH_ATTEMPTS,
      delayMs: 1000,
      onRetry: (error, attempt) => console.warn(`⚠️ ${error.message} — asking again (${attempt}/${BATCH_ATTEMPTS - 1})`),
    },
  );
  if (batch.error) throw new Error(batch.error);
  return { stories: batch.stories.map(shapeStory), lock: batch.lock };
}

// One model's current story: { story } (shaped) or { missing: true } when
// she has none up; asked again while coomeet doesn't answer.
async function authorStory(page, womanId) {
  const reply = await retry(
    async () => {
      const r = await page.evaluate(
        (id, timeout) => window.__cooscrap.authorStory(id, timeout),
        womanId,
        AUTHOR_TIMEOUT,
      );
      if (r.error && r.retry) throw new Error(r.error);
      return r;
    },
    { attempts: 3, delayMs: 1000 },
  );
  if (reply.error) throw new Error(reply.error);
  return reply.missing ? { missing: true } : { story: shapeStory(reply.story) };
}

function logStory(n, story, outcome) {
  line();
  console.log(`🎬 Story ${n}`);
  console.log(`👤 Model id:  ${story.id ?? "unknown"}`);
  console.log(`🏷️  Name:      ${story.name ?? "unknown"}`);
  console.log(`🖼️  Avatar:    ${story.avatar ?? "unknown"}`);
  console.log(`📅 Published: ${story.published ? new Date(story.published).toISOString() : "unknown"}`);
  console.log(`🎞️  Video src: ${story.src}`);
  console.log(`🆔 Story id:  ${story.storyId ?? "unknown"}`);
  console.log(`🖼️  Preview:   ${story.preview ?? "unknown"}`);
  console.log(`🎥 MP4:       ${story.mp4 ?? "unknown"}`);
  console.log(`🌀 GIF:       ${story.gif ?? "unknown"}`);
  console.log(`💰 Balance:   ${story.balance ?? "unknown"}`);
  console.log(`🟢 Online:    ${story.online == null ? "unknown" : story.online ? "yes" : "no"}`);
  console.log(outcome);
}

// Reads coomeet's whole stories feed (or `limit` stories of it) and saves
// what's new, logged in with `account` when there is one. Fills `report`
// in as it goes — even when it fails partway, with what it got through.
async function archive({ page, account, limit, report }) {
  await page.evaluateOnNewDocument(FEED_SCRIPT);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await passIntro(page);
  report.guest = true;
  if (account) {
    console.log(`🔑 Logging in as ${account.email}`);
    report.guest = !(await login(page, account));
    // Reloaded, so the app's connection opens fresh, logged in.
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  // What the archive already has, so stories that would change nothing
  // aren't sent; the rest are saved in batches while the run moves on.
  const known = await getKnownModels();
  console.log(`📚 ${known.size} models already in the archive`);
  const saver = createStorySaver(known, recordStories);

  const seen = new Set();
  const online = new Set();
  let found = 0;
  let ownerUnknown = 0;
  let unsaveable = 0;
  // The models a story of this run came from, so they aren't asked again.
  const seenModels = new Set();

  // A story the run found (from the feed or asked for), counted and queued.
  const take = (story) => {
    const key = story.src ?? story.storyId;
    if (seen.has(key)) return;
    seen.add(key);
    found++;
    if (!story.id) ownerUnknown++;
    if (story.id) seenModels.add(story.id);
    if (story.id && story.online) online.add(story.id);
    // A story without her id can't be filed under anyone, nor one without
    // its own id (the stories table's key), so those are only counted.
    let outcome;
    if (!story.id || !story.storyId) {
      unsaveable++;
      outcome = "⚠️  Not saved — model id or story id unknown";
    } else {
      outcome = saver.add(story) ? "📥 Queued to save" : "⏭️  Already archived — skipped";
    }
    if (isDev) logStory(found, story, outcome);
  };

  try {
    await waitForFeed(page);
    // Whether coomeet took the login: the steps going through doesn't mean
    // it did (a wrong password still lets every step be done).
    const who = await page.evaluate(() => window.__cooscrap.account()).catch(() => null);
    if (who?.statusReg != null) {
      const signedIn = Number(who.statusReg) > 0;
      if (account && !signedIn) console.warn("⚠️ coomeet sees this session as a guest — the login didn't take");
      console.log(`🪪 coomeet: ${signedIn ? "signed in" : "guest"} (statusReg ${who.statusReg}), story lock ${who.lock}s at start`);
      report.guest = !signedIn;
    }
    let toLook = [];
    let slowNoted = false;
    let staleBatches = 0;
    for (;;) {
      const batch = await nextBatch(page, toLook);
      // A guest, or an account without a subscription, gets 20 stories a
      // batch until it has seen its allowance; then coomeet puts a lock on
      // (a few minutes) and sends 5 a batch — said once, since from there
      // the run is ~4× slower.
      if (batch.lock && !slowNoted) {
        slowNoted = true;
        line();
        console.log(
          `🐢 coomeet has limited this session — ${batch.stories.length} stories a batch instead of 20 (lock ${batch.lock}s), so the rest of the run is slower`,
        );
      }
      if (!batch.stories.length) {
        console.log("⏹️  coomeet has no more stories — end of the feed.");
        break;
      }
      // Since Nov 2026 a limited session gets a shuffled draw from a small
      // pool, so one batch of only stories already seen is common and
      // doesn't mean the end; several in a row do — stop rather than loop.
      const fresh = batch.stories.filter((s) => !seen.has(s.src ?? s.storyId));
      if (!fresh.length) {
        if (++staleBatches >= STALE_BATCHES) {
          console.log(`🔁 ${STALE_BATCHES} batches in a row of stories already seen — end of the feed.`);
          break;
        }
        toLook = batch.stories.filter((s) => s.id && s.storyId).map(({ id, storyId }) => ({ id, storyId }));
        continue;
      }
      staleBatches = 0;
      for (const story of fresh) {
        take(story);
        if (limit && found >= limit) break;
      }
      if (limit && found >= limit) break;
      toLook = batch.stories.filter((s) => s.id && s.storyId).map(({ id, storyId }) => ({ id, storyId }));
    }
    const fromFeed = found;
    line();
    console.log(`📰 From the feed: ${fromFeed} stories`);

    // Then every model the archive knows and the feed didn't bring, asked
    // for her current story directly — the feed's lock doesn't hold these
    // back, so this is where most of the run's stories come from.
    const toAsk = [...known.keys()].filter((id) => !seenModels.has(id));
    const t0 = Date.now();
    let next = 0;
    let missing = 0;
    let askFailed = 0;
    const ask = async () => {
      while (next < toAsk.length && !(limit && found >= limit)) {
        const id = toAsk[next++];
        let reply;
        try {
          reply = await authorStory(page, id);
        } catch (error) {
          askFailed++;
          if (askFailed <= 3) console.warn(`⚠️ ${id}'s story: ${error.message}`);
          continue;
        }
        if (reply.missing) missing++;
        else take(reply.story);
      }
    };
    await Promise.all(Array.from({ length: AUTHOR_CONCURRENCY }, ask));
    console.log(
      `👩 Asked ${toAsk.length} known models in ${Math.round((Date.now() - t0) / 1000)}s: ${found - fromFeed} stories, ${missing} with none up${askFailed ? `, ${askFailed} unanswered` : ""}`,
    );
  } finally {
    // Whatever's still queued is saved even if the run stopped early.
    await saver.flush();
    const { stats, added } = saver;
    Object.assign(report, {
      storiesFound: found,
      ownerUnknown,
      saved: stats.saved,
      skipped: stats.skipped,
      failedSaves: stats.failed + unsaveable,
      newModels: added.model ?? 0,
      newStories: added.story ?? 0,
      newNames: added.name ?? 0,
      newAvatars: added.avatar ?? 0,
    });
    line();
    console.log(`🎞️  Stories found:   ${found}`);
    console.log(`❓ Owner unknown:   ${ownerUnknown}`);
    console.log(`💾 Saved:           ${stats.saved}`);
    console.log(`⏭️  Skipped:         ${stats.skipped} (already archived, unchanged)`);
    console.log(`🆕 New models:      ${report.newModels}`);
    console.log(`🆕 New stories:     ${report.newStories}`);
    console.log(`🆕 New names:       ${report.newNames}`);
    console.log(`🆕 New avatars:     ${report.newAvatars}`);
    console.log(`💰 Balance changes: ${added.balance ?? 0}`);
    console.log(`🟢 Online:          ${online.size} models`);
    console.log(`⚠️  Failed to save:  ${report.failedSaves}`);
    const unanswered = await page.evaluate(() => window.__cooscrap.lookTimeouts()).catch(() => null);
    if (unanswered) console.log(`⚠️  Views unanswered: ${unanswered} (coomeet didn't confirm them)`);
  }
}

// The site, as src/sites/index.js lists it (see there for what a site is).
export default {
  id: "coomeet",
  method: "feed",
  browser: true,
  archive,
  faces: facesStore("coomeet"),
};
