import { isDev } from "./log.js";
import { retry } from "./retry.js";

// Saves a run's finds in batches, in the background: queue() and mark()
// never wait on the database, so the run moves on at once. Batches go one
// after another, in order, and flush() waits for all of them.
//
// Two kinds of thing are collected: `items` to save (queue), and `marks` —
// small notes about things that needn't be saved again, such as a model
// seen once more with nothing new (mark). Both go to `send(items, marks)`,
// which saves them and answers how many of each kind of thing were new, as
// { kind: count }; those are added up in `added`. A batch that keeps failing
// is counted in stats.failed and given up on: the run goes on without it.
//
// `describe(counts)` words a batch's counts for the development log.
export function createBatchSaver({
  send,
  describe = (counts) => JSON.stringify(counts),
  batchSize = 100,
  marksBatchSize = 1000,
  attempts = 3,
  retryDelayMs = 2000,
}) {
  let items = [];
  let marks = [];
  let sending = Promise.resolve();
  const stats = { queued: 0, skipped: 0, saved: 0, failed: 0 };
  const added = {};

  async function sendBatch(batchItems, batchMarks) {
    try {
      const counts = await retry(() => send(batchItems, batchMarks), {
        attempts,
        delayMs: retryDelayMs,
        onRetry: (error) => console.warn(`⚠️ Saving failed (${error.message}) — retrying…`),
      });
      for (const [kind, n] of Object.entries(counts ?? {})) added[kind] = (added[kind] ?? 0) + n;
      stats.saved += batchItems.length;
      if (isDev && batchItems.length) {
        console.log(`💾 Saved ${batchItems.length} — new: ${describe(counts ?? {}) || "nothing"}`);
      }
    } catch (error) {
      stats.failed += batchItems.length;
      console.warn(`❌ Failed to save ${batchItems.length}: ${error.message}`);
    }
  }

  function flush() {
    if (items.length || marks.length) {
      const batchItems = items;
      const batchMarks = marks;
      items = [];
      marks = [];
      sending = sending.then(() => sendBatch(batchItems, batchMarks));
    }
    return sending;
  }

  const flushIfFull = () => {
    if (items.length >= batchSize || marks.length >= marksBatchSize) flush();
  };

  return {
    queue(item) {
      items.push(item);
      stats.queued++;
      flushIfFull();
    },
    mark(note) {
      marks.push(note);
      stats.skipped++;
      flushIfFull();
    },
    flush,
    stats,
    added,
  };
}
