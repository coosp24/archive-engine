import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBatchSaver } from "../src/core/batch-saver.js";
import { createStorySaver } from "../src/sites/coomeet/saver.js";

const story = (over = {}) => ({
  id: "1",
  storyId: "10",
  name: "Ana",
  avatar: "a.png",
  balance: 10,
  mp4: "x.mp4",
  online: true,
  ...over,
});

describe("createBatchSaver", () => {
  it("sends items and marks together, and adds up what was new", async () => {
    const sent = [];
    const saver = createBatchSaver({
      batchSize: 2,
      send: async (items, marks) => {
        sent.push({ items, marks });
        return { story: items.length };
      },
    });
    saver.queue("a");
    saver.mark("m");
    saver.queue("b"); // the batch is full: sent
    saver.queue("c");
    await saver.flush();
    assert.deepEqual(sent, [
      { items: ["a", "b"], marks: ["m"] },
      { items: ["c"], marks: [] },
    ]);
    assert.deepEqual(saver.added, { story: 3 });
    assert.deepEqual(saver.stats, { queued: 3, skipped: 1, saved: 3, failed: 0 });
  });

  it("retries a failing batch, then counts it as failed and goes on", async () => {
    let calls = 0;
    const saver = createBatchSaver({
      attempts: 2,
      retryDelayMs: 1,
      send: async () => {
        calls++;
        throw new Error("down");
      },
    });
    saver.queue("a");
    await saver.flush();
    assert.equal(calls, 2);
    assert.equal(saver.stats.failed, 1);
    assert.equal(saver.stats.saved, 0);
  });
});

describe("coomeet's story saver", () => {
  const known = () =>
    new Map([["1", { name: "Ana", avatar: "a.png", storyId: "10", balance: 10, hasMp4: true }]]);

  // Runs `stories` through a saver and answers what was sent.
  async function run(stories, knownModels = known()) {
    const sent = [];
    const saver = createStorySaver(knownModels, async (items, seen) => {
      sent.push({ items: items.map((s) => s.storyId), seen });
      return {};
    });
    const queued = stories.map((s) => saver.add(s));
    await saver.flush();
    return { queued, sent };
  }

  it("only marks an unchanged story's model as seen, online or not", async () => {
    const { queued, sent } = await run([story(), story({ id: "1", online: false })]);
    assert.deepEqual(queued, [false, false]);
    assert.deepEqual(sent, [{ items: [], seen: { seen: ["1", "1"], seenOnline: ["1"], seenOffline: ["1"] } }]);
  });

  it("sends a story when anything about her changed", async () => {
    const changes = [{ name: "Bea" }, { avatar: "b.png" }, { storyId: "11" }, { balance: 60 }];
    for (const change of changes) {
      const { queued } = await run([story(change)]);
      assert.deepEqual(queued, [true], JSON.stringify(change));
    }
  });

  it("keeps what the story couldn't say, rather than calling it a change", async () => {
    const { queued } = await run([story({ name: null, avatar: null, balance: null })]);
    assert.deepEqual(queued, [false]);
  });

  it("sends her current story again when it's missing its MP4", async () => {
    const models = known();
    models.get("1").hasMp4 = false;
    const { queued } = await run([story(), story()], models);
    // Once sent, it's known to have its MP4: the second sighting is skipped.
    assert.deepEqual(queued, [true, false]);
  });

  it("sends a model the archive has never seen", async () => {
    const { queued } = await run([story({ id: "2" })]);
    assert.deepEqual(queued, [true]);
  });
});
