import { parseArgs } from "node:util";
import { runSite } from "./core/run.js";
import { saveRun } from "./db/runs.js";
import { indexFaces } from "./faces/indexer.js";
import { SITES } from "./sites/index.js";

// node . [options]
//
//   --site=<id>          which site to archive (src/sites/); every one when
//                        left out
//   --limit=N            stop after N stories, for trying it out
//   --guest              run logged out, ignoring the accounts table
//   --faces-minutes=N    after the stories, fingerprint faces for up to N
//                        minutes — 30 on CI, where the hour allows it, 2 by
//                        hand; 0 skips it
//   --faces-only         only fingerprint faces (not logged as a run)
//   --faces-limit=N      stop fingerprinting after N images, for trying it out
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

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  const sites = values.site ? [SITES[values.site]] : Object.values(SITES);
  if (!sites[0]) throw new Error(`No site "${values.site}" — there's ${Object.keys(SITES).join(", ")}`);

  const facesMinutes = count(values, "faces-minutes", process.env.CI === "true" ? 30 : 2);
  const faces = { budgetMs: facesMinutes * 60_000, limit: count(values, "faces-limit", Infinity) };
  const browser = {
    executablePath: process.env.BROWSER_PATH || "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    headless: process.env.HEADLESS === "true",
  };

  for (const site of sites) {
    if (values["faces-only"]) {
      await indexFaces(site.faces, faces);
      continue;
    }
    const report = await runSite(site, { browser, guest: values.guest, limit: count(values, "limit", null) });
    // After the stories (the run's time is theirs), faces for the site's
    // search by photo. A failure there is a warning, never the run's: the
    // stories are saved either way.
    if (facesMinutes > 0) {
      try {
        const found = await indexFaces(site.faces, faces);
        report.facesScanned = found.scanned;
        report.facesFound = found.faces;
      } catch (error) {
        console.warn(`⚠️ Faces skipped: ${error.message}`);
      }
    }
    await saveRun(report);
  }
}
