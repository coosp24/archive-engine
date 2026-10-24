import { createBatchSaver } from "../../core/batch-saver.js";
import { describeCounts } from "../../core/log.js";

// Saves the run's stories through `send(stories, seen)` (./store.js's
// recordStories), in the background (src/core/batch-saver.js).
//
// `known` is every model as the archive has her now (getKnownModels). A
// story that would change nothing — her current story, under the same name,
// avatar and balance, already with its MP4 — isn't sent at all; she's only
// marked as seen again, online or offline as the story says (neither when
// it doesn't say). Answers { add(story) → true if it will be saved, flush,
// stats, added }.
export function createStorySaver(known, send) {
  const saver = createBatchSaver({
    describe: describeCounts,
    send: (stories, marks) =>
      send(stories, {
        seen: marks.map((m) => m.id),
        seenOnline: marks.filter((m) => m.online === true).map((m) => m.id),
        seenOffline: marks.filter((m) => m.online === false).map((m) => m.id),
      }),
  });

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
      saver.mark({ id: story.id, online: story.online });
    } else {
      saver.queue(story);
      known.set(story.id, now);
    }
    return !unchanged;
  }

  return { add, flush: saver.flush, stats: saver.stats, added: saver.added };
}
