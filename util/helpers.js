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

export async function type(page, selector, text) {
  try {
    await page.waitForSelector(selector);
    await page.focus(selector);
    await page.type(selector, text);
  } catch (e) {
    // console.warn(`⚠️ Failed to type in: ${selector}`);
  }
}

export function printLine() {
  console.log(
    "-------------------------------------------------------------------------------",
  );
}
