import { formatDuration, isDev, line } from "../core/log.js";
import { mapLimit } from "../core/pool.js";
import { retry } from "../core/retry.js";
import { facesIn } from "./model.js";

// Finds the faces in a site's avatars and story previews and saves a
// fingerprint for each (./model.js), for the web's search by photo. Newest
// images first, so each run's new ones are done before the backlog, which
// is worked through a little every run. A model keeps only so many story
// faces (the database decides which): once she has them, her stories are
// passed over without being downloaded.
//
// The images and where the faces go are the site's: `store` is its
// { todo(limit), record(scans) } (see a site's faces in src/sites/).

// Images fetched and saved per round trip.
const BATCH = 50;
// Images worked on at once: each is downloaded, then fingerprinted.
const CONCURRENCY = 6;
const DOWNLOAD_TIMEOUT = 15000;
// A database call that fails (a dropped connection, a slow reply) is tried
// this many times in all, a few seconds apart.
const DB_ATTEMPTS = 3;
const DB_RETRY_DELAY = 3000;

const withRetry = (fn) =>
  retry(fn, {
    attempts: DB_ATTEMPTS,
    delayMs: DB_RETRY_DELAY,
    onRetry: (error, attempt) =>
      console.warn(`⚠️ ${error.message} — trying again (${attempt}/${DB_ATTEMPTS - 1})`),
  });

// Fingerprints are rounded to 6 decimals: the same matches, a third of the
// bytes on the way to the database.
const rounded = (faces) =>
  faces.map(({ box, score, embedding }) => ({
    box,
    score,
    embedding: embedding.map((x) => Math.round(x * 1e6) / 1e6),
  }));

// One image looked at: { …todo, error, faces }, or null when it couldn't be
// fetched just now (a timeout, a dropped connection) — left for next time.
// An image that's gone or isn't an image is saved with its error, so it
// isn't tried again and again. A capped one (see above) isn't fetched.
async function scan(todo) {
  if (todo.capped) return { ...todo, error: null, faces: [] };
  let bytes;
  try {
    const res = await fetch(todo.image, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
      return res.status === 404 || res.status === 410
        ? { ...todo, error: `HTTP ${res.status}`, faces: [] }
        : null;
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  try {
    return { ...todo, error: null, faces: rounded(await facesIn(bytes)) };
  } catch (error) {
    return { ...todo, error: `Not readable: ${error.message}`.slice(0, 200), faces: [] };
  }
}

// Works through the images not yet looked at until there are none left,
// `budgetMs` has passed, or `limit` images are done. Answers { scanned,
// faces, passed, skipped, done, error } — faces kept, images passed over as
// capped, images that couldn't be fetched; done when nothing's left to look
// at. A database call that keeps failing stops the work, but what was done
// is saved already, and still answered.
export async function indexFaces(store, { budgetMs, limit = Infinity }) {
  const startedAt = Date.now();
  const totals = { scanned: 0, faces: 0, passed: 0, skipped: 0, done: false, error: null };
  try {
    await work();
  } catch (error) {
    totals.error = error.message;
  }
  report();
  return totals;

  async function work() {
    // Images that couldn't be fetched this run, so they aren't asked for again.
    const skipped = new Set();
    const key = (t) => `${t.source}:${t.source_id}`;

    while (Date.now() - startedAt < budgetMs && totals.scanned < limit) {
      const todo = (await withRetry(() => store.todo(Math.min(BATCH + skipped.size, 1000)))).filter(
        (t) => !skipped.has(key(t)),
      );
      if (!todo.length) {
        totals.done = skipped.size === 0;
        break;
      }
      const batch = todo.slice(0, Math.min(BATCH, limit - totals.scanned));
      const scans = await mapLimit(batch, CONCURRENCY, scan);
      batch.forEach((t, i) => {
        if (!scans[i]) skipped.add(key(t));
      });
      totals.skipped = skipped.size;
      const ready = scans.filter(Boolean);
      if (!ready.length) break;

      // Saving the same batch twice is harmless (the database skips images
      // it has), so a retry after a reply that was lost is safe.
      const saved = await withRetry(() => store.record(ready));
      totals.scanned += saved.scanned;
      totals.faces += saved.faces;
      totals.passed += ready.filter((s) => s.capped).length;
      if (isDev) console.log(`🙂 ${saved.scanned} images, ${saved.faces} faces (${totals.scanned} so far)`);
    }
  }

  function report() {
    line();
    console.log(`🙂 Faces: ${totals.scanned} images looked at, ${totals.faces} faces kept`);
    if (totals.passed)
      console.log(`⏭️  ${totals.passed} of them passed over: the model has her story faces already`);
    if (totals.skipped)
      console.log(`⚠️  Couldn't fetch ${totals.skipped} images — they'll be tried next run`);
    if (totals.error) console.warn(`❌ Faces stopped early: ${totals.error}`);
    console.log(
      totals.done
        ? "✅ Every image has been looked at"
        : `⏸️  More left for next time (stopped after ${formatDuration(Date.now() - startedAt)})`,
    );
  }
}
