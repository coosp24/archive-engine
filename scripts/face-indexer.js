import { getFaceTodo, recordFaces } from "../api/face.js";
import { facesIn } from "../util/faces.js";
import { formatDuration, isDev, printLine, wait } from "../util/helpers.js";

// Finds the faces in the archive's avatars and story previews and saves a
// fingerprint for each (util/faces.js, supabase/faces.sql), for the site's
// search by photo. Newest images first, so each run's new ones are done
// before the backlog, which is worked through a little every run. A model
// keeps only so many story faces (the database decides which): once she
// has them, her stories are passed over without being downloaded.

// Images fetched and saved per round trip.
const BATCH = 50;
// Images downloaded at once; the fingerprinting itself is one at a time.
const DOWNLOADS = 6;
const DOWNLOAD_TIMEOUT = 15000;
// A database call that fails (a dropped connection, a slow reply) is tried
// again this many times in all, RETRY_DELAY × attempt apart.
const ATTEMPTS = 3;
const RETRY_DELAY = 3000;

async function retried(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      console.warn(`⚠️ ${error.message} — trying again (${attempt}/${ATTEMPTS - 1})`);
      await wait(RETRY_DELAY * attempt);
    }
  }
}

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
    const res = await fetch(todo.image, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
    });
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
    return {
      ...todo,
      error: `Not readable: ${error.message}`.slice(0, 200),
      faces: [],
    };
  }
}

// `items` through `fn`, at most `limit` at a time, in order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// Works through the images not yet looked at until there are none left,
// `budgetMs` has passed, or `limit` images are done. Answers { scanned,
// faces, passed, skipped, done, error } — faces kept, images passed over
// as capped; done when nothing's left to look at. A
// database call that keeps failing stops the work, but what was done is
// saved already, and still answered.
export default async function indexFaces({ budgetMs, limit = Infinity }) {
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
      const todo = (await retried(() => getFaceTodo(Math.min(BATCH + skipped.size, 1000)))).filter(
        (t) => !skipped.has(key(t)),
      );
      if (!todo.length) {
        totals.done = skipped.size === 0;
        break;
      }
      const batch = todo.slice(0, Math.min(BATCH, limit - totals.scanned));
      const scans = await mapLimit(batch, DOWNLOADS, scan);
      const ready = scans.filter(Boolean);
      batch.forEach((t, i) => {
        if (!scans[i]) skipped.add(key(t));
      });
      totals.skipped = skipped.size;
      if (!ready.length) break;

      // Saving the same batch twice is harmless (record_faces skips images
      // it has), so a retry after a reply that was lost is safe.
      const saved = await retried(() => recordFaces(ready));
      totals.scanned += saved.scanned;
      totals.faces += saved.faces;
      totals.passed += ready.filter((s) => s.capped).length;
      if (isDev)
        console.log(`🙂 ${saved.scanned} images, ${saved.faces} faces (${totals.scanned} so far)`);
    }
  }

  function report() {
    printLine();
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
