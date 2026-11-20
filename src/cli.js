import { parseArgs } from "node:util";
import { runSite } from "./core/run.js";
import { addRunFaces, saveRun } from "./db/runs.js";
import { indexFaces } from "./faces/indexer.js";
import { SITES } from "./sites/index.js";

// node . [options]
//
//   --site=<id>[,<id>…]  which sites to archive (src/sites/); every one when
//                        left out
//   --limit=N            stop after N stories, for trying it out
//   --guest              run logged out, ignoring the accounts table
//   --faces-minutes=N    after every site's stories, fingerprint faces for up
//                        to N minutes in all, shared by the sites — on CI
//                        each site's workflow sets its own (archive-<site>.yml),
//                        2 by hand; 0 skips it
//   --faces-only         only fingerprint faces (not logged as a run)
//   --faces-limit=N      stop fingerprinting after N images a site, for
//                        trying it out
//
// The browser comes from BROWSER_PATH (Brave's usual place on Windows
// otherwise), and runs headless when HEADLESS=true.
const OPTIONS = {
  site: { type: "string" },
  limit: { type: "string" },
  guest: { type: "boolean", default: false },
  "faces-minutes": { type: "string" },
  "faces-only": { type: "boolean", default: false },
  "faces-limit": { type: "string" },
};

// A whole number from an option, or `fallback` when it's left out.
function count(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number, not "${raw}"`);
  return n;
}

// The sites --site names, in the order given; every site when it's left out.
function sitesFrom(option) {
  if (!option) return Object.values(SITES);
  return option.split(",").map((id) => {
    const site = SITES[id.trim()];
    if (!site) throw new Error(`No site "${id.trim()}" — there's ${Object.keys(SITES).join(", ")}`);
    return site;
  });
}

// Fingerprints faces on each site with faces, the budget shared out: each
// site gets an even share of what's left when its turn comes, so time one
// doesn't use passes to the next. Calls `done(site, found)` after each. A
// failure is a warning, never the run's: the stories are saved either way.
async function indexAllFaces(sites, { budgetMs, limit }, done) {
  const withFaces = sites.filter((site) => site.faces);
  const deadline = Date.now() + budgetMs;
  for (const [i, site] of withFaces.entries()) {
    const share = (deadline - Date.now()) / (withFaces.length - i);
    if (share <= 0) break;
    console.log(`🙂 ${site.id}: faces`);
    try {
      await done(site, await indexFaces(site.faces, { budgetMs: share, limit }));
    } catch (error) {
      console.warn(`⚠️ ${site.id}: faces skipped — ${error.message}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  const sites = sitesFrom(values.site);
  const facesMinutes = count(values, "faces-minutes", process.env.CI === "true" ? 25 : 2);
  const faces = { budgetMs: facesMinutes * 60_000, limit: count(values, "faces-limit", Infinity) };

  if (values["faces-only"]) {
    await indexAllFaces(sites, faces, () => {});
    return;
  }

  const browser = {
    executablePath: process.env.BROWSER_PATH || "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    headless: process.env.HEADLESS === "true",
  };
  // Every site's stories first, each logged as soon as it's done — they're
  // what the hour is for. Then faces, with what time is set aside for them.
  const runIds = new Map();
  for (const site of sites) {
    const report = await runSite(site, { browser, guest: values.guest, limit: count(values, "limit", null) });
    runIds.set(site.id, await saveRun(report));
  }
  if (facesMinutes > 0) {
    await indexAllFaces(sites, faces, (site, found) =>
      addRunFaces(runIds.get(site.id), { scanned: found.scanned, faces: found.faces }),
    );
  }
}
