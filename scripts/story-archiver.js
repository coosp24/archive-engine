import { readFile } from "node:fs/promises";
import { formatDuration, printLine } from "../util/helpers.js";
import { getPage, getDataUsageMB } from "../util/context.js";
import { recordStory } from "../api/story.js";

/* ===================== PAGE SCRIPTS ===================== */

// Loaded into the page before coomeet's own code, in this order: owner.js and
// network.js are cooscrap-tool's — they listen to everything the app
// downloads and remember each story file's owner; owner.js also keeps the
// story's publication time — and story.js reads the story on screen and
// presses "next".
const PAGE_SCRIPTS = ["owner.js", "network.js", "story.js"];

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

/* ===================== SCRAPING ===================== */

const currentStory = () =>
  getPage().evaluate(() => window.__cooscrap.currentStory());

// coomeet's "No new videos yet" screen — a guest's limit, or the end of the
// feed: logs what it says and answers true, or false when it isn't showing.
async function reportLimit() {
  const message = await getPage().evaluate(() => window.__cooscrap.limitMessage());
  if (!message) return false;
  console.log(`🚧 coomeet says: "${message}"`);
  return true;
}

// The story on screen once it has a src other than `previousSrc`, with its
// owner if she turns up within OWNER_TIMEOUT. Null if no new story appears.
// "No new videos yet" doesn't cut the wait short: coomeet loads the feed in
// batches of 16, and moving faster than a batch arrives shows that screen
// for a moment before the next story.
async function waitForStory(previousSrc, timeout) {
  const page = getPage();
  try {
    await page.waitForFunction(
      (prev) => {
        const { src } = window.__cooscrap.currentStory();
        return src && src !== prev;
      },
      { timeout },
      previousSrc,
    );
  } catch {
    return null;
  }
  try {
    await page.waitForFunction(() => window.__cooscrap.currentStory().id, {
      timeout: OWNER_TIMEOUT,
    });
  } catch {}
  return currentStory();
}

// `startedAt` is when the whole run began (index.js), so the reported time
// includes launching the browser and logging in, not just the stories.
export default async function archive({ limit = null, startedAt = Date.now() } = {}) {
  const page = getPage();
  const seen = new Set();
  let count = 0;
  let missingOwner = 0;
  let failed = 0;
  // How many of each were new to the archive this run.
  const added = { model: 0, name: 0, avatar: 0, story: 0 };

  let story = await waitForStory(null, FIRST_STORY_TIMEOUT);
  if (!story) {
    if (await reportLimit()) return 0;
    throw new Error("❌ No story showed up on the stories page");
  }

  while (story) {
    // coomeet loops back to the start after the last story.
    if (seen.has(story.src)) {
      console.log("🔁 Back at a story already seen — end of the stories.");
      break;
    }
    seen.add(story.src);
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
      failed++;
      console.warn("⚠️ Not saved — model id or story id unknown");
    } else {
      try {
        const isNew = await recordStory(story);
        for (const kind of Object.keys(added)) if (isNew[kind]) added[kind]++;
        const news = Object.keys(added).filter((kind) => isNew[kind]);
        console.log(news.length ? `✅ Saved — new ${news.join(", ")}` : "✅ Saved — nothing new");
      } catch (error) {
        failed++;
        console.warn(error.message);
      }
    }

    if (limit && count >= limit) break;

    const pressed = await page.evaluate(() => window.__cooscrap.nextStory());
    if (!pressed) {
      console.log("⏹️  No next button — end of the stories.");
      break;
    }
    story = await waitForStory(story.src, NEXT_STORY_TIMEOUT);
    if (!story && !(await reportLimit())) {
      console.log("⏹️  Next didn't bring up a new story — end of the stories.");
    }
  }

  printLine();
  console.log(`🎞️  Stories found:   ${count}`);
  console.log(`❓ Owner unknown:   ${missingOwner}`);
  console.log(`🆕 New models:      ${added.model}`);
  console.log(`🆕 New stories:     ${added.story}`);
  console.log(`🆕 New names:       ${added.name}`);
  console.log(`🆕 New avatars:     ${added.avatar}`);
  console.log(`⚠️  Failed to save:  ${failed}`);
  console.log(`📡 Data consumed:   ${getDataUsageMB()} MB`);
  console.log(`⏱️  Total time:      ${formatDuration(Date.now() - startedAt)}`);
  return count;
}
