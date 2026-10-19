import { readFile } from "node:fs/promises";
import { formatDuration, printLine } from "../util/helpers.js";
import { getConfig, getPage, getDataUsageMB } from "../util/context.js";
import { getKnownModels } from "../api/story.js";
import { createBatchSaver } from "../util/batch-saver.js";

/* ===================== PAGE SCRIPTS ===================== */

// Loaded into the page before coomeet's own code, in this order: owner.js and
// network.js are cooscrap-tool's — they listen to everything the app
// downloads and remember each story file's owner; owner.js also keeps the
// story's publication time — story.js reads the story on screen and presses
// "next" (the slider method), and feed.js reads the feed straight from
// coomeet's server (the default).
const PAGE_SCRIPTS = ["owner.js", "network.js", "story.js", "feed.js"];

export async function injectPageScripts(page) {
  for (const file of PAGE_SCRIPTS) {
    const source = await readFile(new URL(`../page/${file}`, import.meta.url), "utf8");
    await page.evaluateOnNewDocument(source);
  }
}

/* ===================== TIMEOUTS ===================== */

// How long the first story's video gets to show up after the page loads.
const FIRST_STORY_TIMEOUT = 15000;
// How long a press of "next" gets to put a different video on screen before
// the run takes it that there are no more stories — long enough for the next
// batch of the feed to arrive.
const NEXT_STORY_TIMEOUT = 15000;
// How long to wait for the owner of a story to be known once its video is
// on screen — the payload naming her usually arrived well before.
const OWNER_TIMEOUT = 3000;

// coomeet's app keeps every story it has shown in memory, so each "next"
// gets slower the longer the page is open: 30ms a story at first, 38ms by
// 1,000, 136ms by 4,500. Reloading the page every so often starts it fresh,
// for ~2s a reload — and the feed carries on with the stories not seen yet.
const RELOAD_EVERY = 1000;
// …mostly: a story or two from before a reload can come round again, so for
// a while after one, a repeat is passed over rather than taken for the end
// of the feed — until RELOAD_SETTLE new stories have come, or
// RELOAD_MAX_REPEATS repeats (then the feed really has started over).
const RELOAD_SETTLE = 20;
const RELOAD_MAX_REPEATS = 50;

// The feed method: how long coomeet's connection gets to open after the page
// loads, and how long a batch request gets to be answered (~0.3s normally).
// Now and then coomeet lets one go unanswered; asked again a few seconds
// later, it answers — so a request is retried BATCH_ATTEMPTS times before
// the run gives up.
const FEED_READY_TIMEOUT = 20000;
const BATCH_TIMEOUT = 5000;
const BATCH_ATTEMPTS = 6;

/* ===================== SCRAPING ===================== */

// coomeet's "No new videos yet" screen — a guest's limit, or the end of the
// feed: logs what it says and answers true, or false when it isn't showing.
async function reportLimit() {
  const message = await getPage().evaluate(() => window.__cooscrap.limitMessage());
  if (!message) return false;
  console.log(`🚧 coomeet says: "${message}"`);
  return true;
}

// The first story, once it's on screen with its owner if she turns up within
// OWNER_TIMEOUT; null if none appears.
const firstStory = () =>
  getPage().evaluate(
    (timeout, ownerTimeout) => window.__cooscrap.waitForStory(null, timeout, ownerTimeout),
    FIRST_STORY_TIMEOUT,
    OWNER_TIMEOUT,
  );

// Presses "next" and waits for the story after `previousSrc`, in one call
// (see advance in page/story.js). "No new videos yet" doesn't cut the wait
// short: coomeet loads the feed in batches of 16, and moving faster than a
// batch arrives shows that screen for a moment before the next story.
const nextStory = (previousSrc) =>
  getPage().evaluate(
    (prev, timeout, ownerTimeout) => window.__cooscrap.advance(prev, timeout, ownerTimeout),
    previousSrc,
    NEXT_STORY_TIMEOUT,
    OWNER_TIMEOUT,
  );

// Moves on from the story with `previousSrc`: the next story, or null — with
// the reason logged — when there isn't one.
async function moveOn(previousSrc) {
  const next = await nextStory(previousSrc);
  if (!next.pressed) {
    console.log("⏹️  No next button — end of the stories.");
    return null;
  }
  if (!next.story && !(await reportLimit())) {
    console.log("⏹️  Next didn't bring up a new story — end of the stories.");
  }
  return next.story;
}

// Reloads the stories page (see RELOAD_EVERY) and answers its first story,
// or null — with the reason logged — when there isn't one.
async function reload(count) {
  printLine();
  console.log(`🔄 Reloading the stories page to keep it fast (${count} stories so far)`);
  await getPage().goto(getConfig().url, { waitUntil: "domcontentloaded" });
  const story = await firstStory();
  if (!story && !(await reportLimit())) {
    console.log("⏹️  No story after reloading — end of the stories.");
  }
  return story;
}

// `startedAt` is when the whole run began (index.js), so the reported time
// includes launching the browser and logging in, not just the stories.
// `slider` clicks through the stories page instead of reading the feed from
// coomeet's server — the old way, kept in case coomeet changes its protocol.
// `reloadEvery` is for testing the slider's reload with fewer stories.
export default async function archive({
  limit = null,
  startedAt = Date.now(),
  slider = false,
  reloadEvery = RELOAD_EVERY,
} = {}) {
  const seen = new Set();
  let count = 0;
  let missingOwner = 0;
  let unsaveable = 0;

  // What the archive already has, so stories that would change nothing
  // aren't sent; the rest are saved in batches while the run moves on.
  const known = await getKnownModels();
  console.log(`📚 ${known.size} models already in the archive`);
  const saver = createBatchSaver(known);

  try {
    await (slider ? walkStories() : readFeed());
  } finally {
    // Whatever's still queued is saved even if the run stopped early.
    await saver.flush();
  }

  // Logs one story and queues it to be saved. Answers true once the run has
  // reached --limit.
  function record(story) {
    count++;
    if (!story.id) missingOwner++;

    printLine();
    console.log(`🎬 Story ${count}`);
    console.log(`👤 Model id:  ${story.id ?? "unknown"}`);
    console.log(`🏷️  Name:      ${story.name ?? "unknown"}`);
    console.log(`🖼️  Avatar:    ${story.avatar ?? "unknown"}`);
    console.log(
      `📅 Published: ${story.published ? new Date(story.published).toISOString() : "unknown"}`,
    );
    console.log(`🎞️  Video src: ${story.src}`);
    console.log(`🆔 Story id:  ${story.storyId ?? "unknown"}`);
    console.log(`🖼️  Preview:   ${story.preview ?? "unknown"}`);

    // A story without her id can't be filed under anyone, nor one without
    // its own id (the stories table's key), so those are only logged.
    if (!story.id || !story.storyId) {
      unsaveable++;
      console.warn("⚠️ Not saved — model id or story id unknown");
    } else {
      console.log(saver.add(story) ? "📥 Queued to save" : "⏭️  Already archived — skipped");
    }
    return Boolean(limit && count >= limit);
  }

  // The feed method (page/feed.js): batches of 20 straight from coomeet's
  // server, each batch marked viewed as the next is asked for, until one
  // comes back empty.
  async function readFeed() {
    const page = getPage();
    try {
      await page.waitForFunction(() => window.__cooscrap.feedReady(), {
        timeout: FEED_READY_TIMEOUT,
      });
    } catch {
      throw new Error("❌ coomeet's connection didn't open");
    }

    // The next batch, asked for again while coomeet doesn't answer. Sending
    // the same looks again on a retry is harmless.
    const nextBatch = async (toLook) => {
      for (let attempt = 1; ; attempt++) {
        const batch = await page.evaluate(
          (look, timeout) => window.__cooscrap.nextBatch(look, timeout),
          toLook,
          BATCH_TIMEOUT,
        );
        if (!batch.error) return batch;
        if (!batch.retry || attempt >= BATCH_ATTEMPTS) throw new Error(`❌ ${batch.error}`);
        console.warn(`⚠️ ${batch.error} — asking again (${attempt}/${BATCH_ATTEMPTS - 1})`);
      }
    };

    let toLook = [];
    for (;;) {
      const batch = await nextBatch(toLook);
      if (!batch.stories.length) {
        console.log("⏹️  coomeet has no more stories — end of the feed.");
        return;
      }
      // A batch of nothing but stories already seen means the feed has
      // started over (or the looks aren't landing) — stop rather than loop.
      const fresh = batch.stories.filter((s) => !seen.has(s.src ?? s.storyId));
      if (!fresh.length) {
        console.log("🔁 A batch of stories already seen — end of the feed.");
        return;
      }
      for (const story of fresh) {
        seen.add(story.src ?? story.storyId);
        if (record(story)) return;
      }
      toLook = batch.stories
        .filter((s) => s.id && s.storyId)
        .map(({ id, storyId }) => ({ id, storyId }));
    }
  }

  // The slider method: click "next" through the stories page.
  async function walkStories() {
    let story = await firstStory();
    if (!story) {
      if (await reportLimit()) return;
      throw new Error("❌ No story showed up on the stories page");
    }

    // Since the last reload: new stories seen, and repeats passed over.
    let sinceReload = Infinity;
    let repeatsSinceReload = 0;
    while (story) {
      if (seen.has(story.src)) {
        if (sinceReload < RELOAD_SETTLE && repeatsSinceReload < RELOAD_MAX_REPEATS) {
          repeatsSinceReload++;
          console.log("↪️  A story from before the reload — passed over");
          story = await moveOn(story.src);
          continue;
        }
        // coomeet has looped back to the start after the last story.
        console.log("🔁 Back at a story already seen — end of the stories.");
        break;
      }
      sinceReload++;
      seen.add(story.src);
      if (record(story)) break;

      // Pressing "next" first, even before a reload, so coomeet counts this
      // story as seen; the one it brings up is the reload's first story.
      story = await moveOn(story.src);
      if (story && count % reloadEvery === 0) {
        story = await reload(count);
        sinceReload = 0;
        repeatsSinceReload = 0;
      }
    }
  }

  const { stats, added } = saver;
  printLine();
  console.log(`🎞️  Stories found:   ${count}`);
  console.log(`❓ Owner unknown:   ${missingOwner}`);
  console.log(`💾 Saved:           ${stats.saved}`);
  console.log(`⏭️  Skipped:         ${stats.skipped} (already archived, unchanged)`);
  console.log(`🆕 New models:      ${added.model}`);
  console.log(`🆕 New stories:     ${added.story}`);
  console.log(`🆕 New names:       ${added.name}`);
  console.log(`🆕 New avatars:     ${added.avatar}`);
  console.log(`⚠️  Failed to save:  ${stats.failed + unsaveable}`);
  if (!slider) {
    const unanswered = await getPage()
      .evaluate(() => window.__cooscrap.lookTimeouts())
      .catch(() => null);
    if (unanswered) console.log(`⚠️  Views unanswered: ${unanswered} (coomeet didn't confirm them)`);
  }
  console.log(`📡 Data consumed:   ${getDataUsageMB()} MB`);
  console.log(`⏱️  Total time:      ${formatDuration(Date.now() - startedAt)}`);
  return count;
}
