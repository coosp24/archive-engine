import { recordStories } from "../api/story.js";
import { isDev, wait } from "./helpers.js";

// How many stories go to Supabase per call, and how many skipped models are
// marked seen per call. A call takes ~0.2s whatever its size, so fewer,
// bigger calls are what make the run fast.
const BATCH_SIZE = 100;
const SEEN_BATCH_SIZE = 1000;
const ATTEMPTS = 3;
const RETRY_DELAY = 2000;

const PLURAL = {
  model: "models",
  name: "names",
  avatar: "avatars",
  story: "stories",
  balance: "balances",
};

// Saves stories in batches, in the background: add() never waits on the
// database, so the run moves on to the next story at once. Batches are sent
// one after another, in order, and flush() waits for all of them.
//
// `known` is every model as the archive has her now (getKnownModels). A
// story that would change nothing — her current story, under the same name,
// avatar and balance, already with its MP4 — isn't sent at all; she's only
// marked as seen again, online or offline as the story says (neither when
// it doesn't say).
export function createBatchSaver(known) {
  let pending = [];
  let seen = new Set();
  let seenOnline = new Set();
  let seenOffline = new Set();
  let sending = Promise.resolve();
  const stats = { queued: 0, skipped: 0, saved: 0, failed: 0 };
  const added = { model: 0, name: 0, avatar: 0, story: 0, balance: 0 };

  async function send(stories, seenIds, onlineIds, offlineIds) {
    for (let attempt = 1; ; attempt++) {
      try {
        const isNew = await recordStories(stories, seenIds, onlineIds, offlineIds);
        for (const kind of Object.keys(added)) added[kind] += isNew[kind] ?? 0;
        stats.saved += stories.length;
        if (isDev && stories.length) {
          const news = Object.keys(added)
            .filter((kind) => isNew[kind])
            .map((kind) => `${isNew[kind]} ${isNew[kind] === 1 ? kind : PLURAL[kind]}`);
          console.log(`💾 Saved ${stories.length} stories — new: ${news.join(", ") || "nothing"}`);
        }
        return;
      } catch (error) {
        if (attempt >= ATTEMPTS) {
          stats.failed += stories.length;
          console.warn(`❌ Failed to save ${stories.length} stories: ${error.message}`);
          return;
        }
        console.warn(`⚠️ Saving failed (${error.message}) — retrying…`);
        await wait(RETRY_DELAY * attempt);
      }
    }
  }

  function flush() {
    if (pending.length || seen.size) {
      const stories = pending;
      const seenIds = [...seen];
      const onlineIds = [...seenOnline];
      const offlineIds = [...seenOffline];
      pending = [];
      seen = new Set();
      seenOnline = new Set();
      seenOffline = new Set();
      sending = sending.then(() => send(stories, seenIds, onlineIds, offlineIds));
    }
    return sending;
  }

  // Queues a story; answers true if it will be saved, false if it was
  // skipped because the archive already has it as it is.
  function add(story) {
    const was = known.get(story.id);
    // A name, avatar or balance the run couldn't read keeps what's stored.
    const now = {
      name: story.name ?? was?.name ?? null,
      avatar: story.avatar ?? was?.avatar ?? null,
      storyId: story.storyId,
      balance: story.balance ?? was?.balance ?? null,
      hasMp4: Boolean(story.mp4) || (was?.storyId === story.storyId && Boolean(was?.hasMp4)),
    };
    // Her current story without its MP4 was saved before the archive kept
    // MP4s: sending it again fills that in.
    const unchanged =
      was &&
      was.storyId === now.storyId &&
      was.name === now.name &&
      was.avatar === now.avatar &&
      was.balance === now.balance &&
      (was.hasMp4 || !story.mp4);

    if (unchanged) {
      seen.add(story.id);
      if (story.online === true) seenOnline.add(story.id);
      if (story.online === false) seenOffline.add(story.id);
      stats.skipped++;
    } else {
      pending.push(story);
      known.set(story.id, now);
      stats.queued++;
    }
    if (pending.length >= BATCH_SIZE || seen.size >= SEEN_BATCH_SIZE) flush();
    return !unchanged;
  }

  return { add, flush, stats, added };
}
