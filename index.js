import puppeteer from "puppeteer-core";
import { passIntro } from "./util/helpers.js";
import { getDataUsageMB, setContext } from "./util/context.js";
import { login } from "./util/form-logger.js";
import { getPrimaryAccount } from "./api/account.js";
import { saveRun } from "./api/run.js";
import archiveStories, { injectPageScripts } from "./scripts/story-archiver.js";

/* ===================== CONSTANTS ===================== */

const CONFIG = {
  executablePath:
    process.env.BROWSER_PATH ||
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  // Logging in happens on the dialog page, where cooscrap-engine's login form
  // selectors are known to work; the stories are read from `url` after.
  loginUrl: "https://p.coomeet.com/dialog",
  url: "https://p.coomeet.com/stories/all",
  timeout: 3000,
  headless: process.env.HEADLESS === "true",
};

/* ===================== CLI ARGS ===================== */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, ...rest] = a.slice(2).split("=");
      return [key, rest.length ? rest.join("=") : true];
    }),
);

// --limit=N stops after N stories, for trying it out. --slider clicks
// through the stories page instead of reading the feed from coomeet's
// server, the old way; with it, --reload-every=N reloads the page every N
// stories instead of every 1,000, for trying the reload without a long run.
const limit = Number(args.limit) || null;
const slider = args.slider === true;
const reloadEvery = Number(args["reload-every"]) || undefined;

// --guest runs logged out: no account needed. The feed method still reads
// the whole feed — coomeet's ~10-story guest limit is only enforced by its
// pages — but in batches of 5 instead of 20, so it takes ~4× longer. The
// slider method, which goes through those pages, stops at the limit.
const guest = args.guest === true;

/* ===================== MAIN ===================== */

async function launchBrowser(attempts = 2) {
  try {
    return await puppeteer.launch({
      headless: CONFIG.headless,
      executablePath: CONFIG.executablePath,
      timeout: 120_000,
      dumpio: process.env.CI === "true",
      args: [
        "--start-maximized",
        "--blink-settings=imagesEnabled=false",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      defaultViewport: null,
    });
  } catch (error) {
    if (attempts > 1) {
      console.warn(`⚠️ Browser launch failed (${error.message}) — retrying…`);
      return launchBrowser(attempts - 1);
    }
    throw error;
  }
}

async function main() {
  const startedAt = Date.now();
  // What the run did, for the scrape log (api/run.js); filled in as it goes.
  const run = { startedAt, slider, limit };
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setContext(page, CONFIG);
    await injectPageScripts(page);
    await page.goto(CONFIG.loginUrl, { waitUntil: "domcontentloaded" });
    await passIntro(page);

    // A subscribed account gets the feed 20 stories a batch; a guest (and an
    // account without a subscription) 5 a batch. With no primary account in
    // the accounts table, the run goes ahead as a guest.
    const account = guest ? null : await getPrimaryAccount();
    run.guest = !account;
    if (account) {
      console.log(`🔑 Logging in as ${account.email}`);
      await login(account.email, account.password);
    } else if (guest) {
      console.log("👤 Running as a guest — not logged in");
    } else {
      console.log("👤 No primary account in the accounts table — running as a guest");
    }

    // The slider method needs the stories page. The feed method reads from
    // the dialog page instead, where the app doesn't load stories itself —
    // reloaded, so its connection opens fresh (logged in, unless --guest).
    await page.goto(slider ? CONFIG.url : CONFIG.loginUrl, { waitUntil: "domcontentloaded" });
    await archiveStories({ limit, startedAt, slider, reloadEvery, report: run });
  } catch (error) {
    console.error(error.message);
    run.error = error.message;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    run.finishedAt = Date.now();
    run.dataMB = Number(getDataUsageMB());
    await saveRun(run);
  }
}

main();
