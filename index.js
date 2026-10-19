import puppeteer from "puppeteer-core";
import { click } from "./util/helpers.js";
import { setContext } from "./util/context.js";
import { login } from "./util/form-logger.js";
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
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setContext(page, CONFIG);
    await injectPageScripts(page);
    await page.goto(CONFIG.loginUrl, { waitUntil: "domcontentloaded" });
    await click(page, ".gender-item.male");
    await click(page, ".terms-actions button, .terms-actions div");

    // A logged-out guest only gets ~10 stories; the subscribed account
    // scrolls without limit.
    const { COOMEET_EMAIL: email, COOMEET_PASSWORD: password } = process.env;
    if (!email || !password) {
      throw new Error("❌ Set COOMEET_EMAIL and COOMEET_PASSWORD in .env");
    }
    console.log(`🔑 Logging in as ${email}`);
    await login(email, password);

    // The slider method needs the stories page. The feed method reads from
    // the dialog page instead, where the app doesn't load stories itself —
    // reloaded, so its connection opens logged in.
    await page.goto(slider ? CONFIG.url : CONFIG.loginUrl, { waitUntil: "domcontentloaded" });
    await archiveStories({ limit, startedAt, slider, reloadEvery });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

main();
