/* ===================== LOGGING ===================== */

// ENV=development logs every story and every batch saved as the run goes;
// otherwise (as on CI) a run logs only its start, its problems and the final
// report.
export const isDev = process.env.ENV === "development";

/* ===================== BROWSER HELPERS ===================== */

export async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function click(page, selector, timeout = 3000) {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.click(selector);
  } catch {
    // console.warn(`⚠️ Failed to click: ${selector}`);
  }
}

// coomeet's first screens: pick a gender, then accept the terms. Until
// they're done the app never opens its connection, which fails the run as
// "the app never opened its socket". On a slow machine (as on CI) they can
// take a while to show, so each gets up to `timeout` — waiting on whichever
// comes first, a screen to click or the app opening its socket, so a page
// that's past them already (a reload once the choice is saved) isn't held up.
const GENDER = ".gender-item.male";
const TERMS = ".terms-actions button, .terms-actions div";

export async function passIntro(page, timeout = 20000) {
  await page
    .waitForFunction(
      (gender, terms) =>
        document.querySelector(gender) ||
        document.querySelector(terms) ||
        window.__cooscrap?.socketOpened?.(),
      { timeout },
      GENDER,
      TERMS,
    )
    .catch(() => {});
  if (await page.$(GENDER)) {
    await page.click(GENDER);
    // The terms follow the gender choice.
    await page.waitForSelector(TERMS, { timeout }).catch(() => {});
  }
  if (await page.$(TERMS)) await page.click(TERMS);
}

export async function type(page, selector, text) {
  try {
    await page.waitForSelector(selector);
    await page.focus(selector);
    await page.type(selector, text);
  } catch (e) {
    // console.warn(`⚠️ Failed to type in: ${selector}`);
  }
}

// A duration for the logs: "1h 02m 05s", "3m 12s", "45s".
export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export function printLine() {
  console.log(
    "-------------------------------------------------------------------------------",
  );
}
