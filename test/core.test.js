import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration } from "../src/core/log.js";
import { mapLimit } from "../src/core/pool.js";
import { retry } from "../src/core/retry.js";

describe("formatDuration", () => {
  it("reads like a stopwatch", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(192_000), "3m 12s");
    assert.equal(formatDuration(3_725_000), "1h 02m 05s");
  });
});

describe("retry", () => {
  it("answers the first success", async () => {
    let calls = 0;
    const retried = [];
    const value = await retry(
      async () => {
        if (++calls < 3) throw new Error(`fail ${calls}`);
        return "ok";
      },
      { attempts: 3, delayMs: 1, onRetry: (error, attempt) => retried.push([error.message, attempt]) },
    );
    assert.equal(value, "ok");
    assert.deepEqual(retried, [
      ["fail 1", 1],
      ["fail 2", 2],
    ]);
  });

  it("throws the last failure once out of attempts", async () => {
    await assert.rejects(
      retry(async () => {
        throw new Error("down");
      }, { attempts: 2, delayMs: 1 }),
      /down/,
    );
  });
});

describe("mapLimit", () => {
  it("keeps the items' order, and never runs more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return ms * 2;
    });
    assert.deepEqual(out, [60, 20, 40, 10, 30]);
    assert.equal(most, 2);
  });
});
