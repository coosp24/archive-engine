import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { createHttp } from "../src/core/http.js";
import { describeCounts, formatDuration } from "../src/core/log.js";
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

describe("describeCounts", () => {
  it("words what was new, leaving out what wasn't", () => {
    assert.equal(describeCounts({ model: 1, story: 3, name: 0 }), "1 model, 3 stories");
    assert.equal(describeCounts({ story: 2 }, { story: ["reel", "reels"] }), "2 reels");
    assert.equal(describeCounts({}), "");
  });
});

describe("createHttp", () => {
  it("reads JSON, sends its headers, and counts what it received", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/json") res.end(JSON.stringify({ seen: req.headers["x-site"], method: req.method }));
      else res.writeHead(404).end("not found");
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const http = createHttp({ headers: { "X-Site": "test" } });
      const ok = await http.request(`${base}/json`, { method: "POST", body: { a: 1 } });
      assert.deepEqual(ok, { status: 200, ok: true, json: { seen: "test", method: "POST" } });
      const missing = await http.request(`${base}/nope`);
      assert.deepEqual(missing, { status: 404, ok: false, json: null });
      assert.ok(http.megabytes() > 0);
    } finally {
      server.close();
    }
  });
});
