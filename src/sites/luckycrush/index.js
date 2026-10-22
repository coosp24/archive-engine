import { isDev, line } from "../../core/log.js";
import { retry, wait } from "../../core/retry.js";
import { facesStore } from "../../db/faces.js";
import { shapeModel } from "./model.js";
import { recordModels } from "./store.js";

// luckycrush (luckycrush.com): a random video chat, with no stories or
// profiles. All it shows of its models is the ones it recommends to a
// signed-up man — some 20 free for a call at the moment, the list changing
// slowly — so a run signs in and reads that list a few times over, and
// saves who was on it (./store.js, supabase/luckycrush/).
//
// In a browser: luckycrush's API is behind Cloudflare, which turns plain
// requests away; from inside its page, they go through.

const SITE = "https://www.luckycrush.com/";
const API = "https://api-public.luckycrush.com";
// The list, read this many times this far apart: about 2 minutes, which
// sees a few more models than one read.
const SAMPLES = 5;
const SAMPLE_INTERVAL = 30_000;

// A request from inside luckycrush's page, with its cookies: { status, body }.
const call = (page, path, options = {}) =>
  page.evaluate(
    async ({ url, options }) => {
      const res = await fetch(url, { credentials: "include", ...options });
      return { status: res.status, body: await res.text() };
    },
    { url: `${API}${path}`, options },
  );

async function signIn(page, account) {
  const res = await call(page, "/buurn/public/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: account.email, password: account.password }).toString(),
  });
  if (res.status !== 200) {
    throw new Error(`luckycrush refused the login (HTTP ${res.status}: ${res.body.slice(0, 80)})`);
  }
}

async function recommendations(page) {
  const res = await call(page, "/buurn/r/model-recommendations");
  if (res.status !== 200) throw new Error(`luckycrush's recommendations answered HTTP ${res.status}`);
  return JSON.parse(res.body).recommendations ?? [];
}

// Signs in, reads the recommended models SAMPLES times (or until `limit`
// are seen), and saves every one: new ones added, the rest marked seen and
// online. Fills `report` in as it goes.
async function archive({ page, account, limit, report }) {
  if (!account) throw new Error("luckycrush shows its models only to a signed-up man: add a primary luckycrush account");
  report.guest = false;
  await retry(() => page.goto(SITE, { waitUntil: "networkidle2", timeout: 60_000 }), { attempts: 2, delayMs: 5000 });
  console.log(`🔑 Logging in as ${account.email}`);
  await signIn(page, account);

  const seen = new Map();
  let unsaveable = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const list = await recommendations(page);
    const before = seen.size;
    for (const raw of list) {
      const model = shapeModel(raw);
      if (!model.modelId) unsaveable++;
      else seen.set(model.modelId, model);
    }
    if (isDev) console.log(`👀 Read ${i + 1}: ${list.length} recommended, ${seen.size - before} new (${seen.size} so far)`);
    if (limit && seen.size >= limit) break;
    if (i < SAMPLES - 1) await wait(SAMPLE_INTERVAL);
  }
  const models = [...seen.values()].slice(0, limit ?? undefined);

  const added = models.length
    ? await retry(() => recordModels(models), {
        attempts: 3,
        delayMs: 2000,
        onRetry: (error) => console.warn(`⚠️ Saving failed (${error.message}) — retrying…`),
      })
    : {};
  Object.assign(report, {
    storiesFound: 0,
    ownerUnknown: unsaveable,
    saved: models.length,
    skipped: 0,
    failedSaves: unsaveable,
    newModels: added.model ?? 0,
    newStories: 0,
    newNames: added.name ?? 0,
    newAvatars: added.avatar ?? 0,
  });
  line();
  console.log(`👀 Recommended:     ${models.length} models over ${SAMPLES} reads`);
  console.log(`🆕 New models:      ${report.newModels}`);
  console.log(`🆕 New names:       ${report.newNames}`);
  console.log(`🆕 New avatars:     ${report.newAvatars}`);
  if (unsaveable) console.log(`⚠️  Without an id:   ${unsaveable}`);
}

// The site, as src/sites/index.js lists it (see there for what a site is).
export default {
  id: "luckycrush",
  method: "recommended",
  browser: true,
  archive,
  faces: facesStore("luckycrush"),
};
