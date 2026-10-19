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

// --limit=N stops after N stories, for trying it out.
const limit = Number(args.limit) || null;

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

    await page.goto(CONFIG.url, { waitUntil: "domcontentloaded" });
    await archiveStories({ limit, startedAt });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

main();
