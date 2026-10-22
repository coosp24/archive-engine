import { wait } from "../../core/retry.js";

// Getting into coomeet's app in the browser: past its first screens, and
// logged in.

// coomeet's first screens: pick a gender, then accept the terms. Until
// they're done the app never opens its connection. On a slow machine (as on
// CI) they can take a while to show, so each gets up to `timeout` — waiting
// on whichever comes first, a screen to click or the app opening its
// socket, so a page that's past them already (a reload once the choice is
// saved) isn't held up.
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

// The login form, opened from the avatar in the chat's header (the same
// steps as cooscrap-engine's).
const POPUP =
  "#application-wrapper > div.coomeet-chat > div.popup-overlay-wrapper > div.popup-overlay.visible > div > div.popup-overlay-content > div > div.ui-scroll-area > div > div.popup-component > div > div";
const STEPS = {
  openMenu:
    "#application-wrapper > div.coomeet-chat > div.chat-header > div.signed-in-user > div > div.ui-user-avatar > div",
  openSignIn: `${POPUP} > div > form > div.form-content > div.form-content__footer > div > span`,
  email: 'input[type="email"]',
  password: 'input[type="password"]',
  submit: `${POPUP} > form > div.form-actions > button`,
};
const STEP_TIMEOUT = 5000;

// Logs in with `account` ({ email, password }). A step that can't be done
// (coomeet changed its page, say) is warned about rather than thrown: the
// run goes on as a guest — slower, 5 stories a batch instead of 20 — instead
// of not at all. Answers whether every step went through.
export async function login(page, { email, password }) {
  const step = async (name, action) => {
    try {
      await page.waitForSelector(STEPS[name], { timeout: STEP_TIMEOUT });
      await action(STEPS[name]);
      return true;
    } catch (error) {
      console.warn(`⚠️ Login step "${name}" failed (${error.message}) — going on as a guest`);
      return false;
    }
  };
  const done =
    (await step("openMenu", (s) => page.click(s))) &&
    (await step("openSignIn", (s) => page.click(s))) &&
    (await step("email", (s) => page.type(s, email))) &&
    (await step("password", (s) => page.type(s, password))) &&
    (await step("submit", (s) => page.click(s)));
  // The app takes a moment to take the login in before the page is reloaded.
  await wait(1000);
  return done;
}
