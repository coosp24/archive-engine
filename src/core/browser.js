import puppeteer from "puppeteer-core";

// The archive reads data, not pictures. Images are switched off in the
// browser itself (imagesEnabled=false below): blocking their requests isn't
// enough, as a page still shows the ones in the browser's cache, or inlined
// in its own code, without a request that can be blocked. Media and fonts
// are aborted before they're requested; everything else goes through
// untouched, so the browser's own HTTP cache keeps caching scripts, styles
// and API responses as usual (puppeteer-core 24 leaves the cache on when
// request interception is enabled).
const BLOCKED_TYPES = new Set(["image", "media", "font"]);

// The browser, launched once more if the first try fails (a slow CI machine
// sometimes times out starting it).
export async function launchBrowser({ executablePath, headless }, attempts = 2) {
  try {
    return await puppeteer.launch({
      headless,
      executablePath,
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
    if (attempts <= 1) throw error;
    console.warn(`⚠️ Browser launch failed (${error.message}) — retrying…`);
    return launchBrowser({ executablePath, headless }, attempts - 1);
  }
}

// Sets a page up for a run: what it may download, and — headless — looking
// like an ordinary browser. Answers a function giving the data it has
// downloaded so far, in MB: what came over the network, not what the
// browser's cache answered.
export async function preparePage(page, { headless }) {
  // A headless browser shows itself to sites in several ways; these are the
  // ones that changed what coomeet renders.
  if (headless) {
    const ua = await page.browser().userAgent();
    await page.setUserAgent(ua.replace("Headless", ""));
    // --start-maximized does nothing headless, and a narrow window gets the
    // phone layout.
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (BLOCKED_TYPES.has(req.resourceType())) req.abort();
    else req.continue();
  });

  let bytes = 0;
  page.on("response", (response) => {
    if (response.fromCache() || response.fromServiceWorker()) return;
    bytes += Number(response.headers()["content-length"]) || 0;
  });
  return () => bytes / (1024 * 1024);
}
