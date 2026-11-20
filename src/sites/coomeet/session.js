import { wait } from "../../core/retry.js";

// Getting into coomeet's app in the browser: past its first screens, and
// logged in.

// coomeet's first screens: pick a gender, then accept the terms. Until
// they're done the app never opens its connection. On a slow machine (as on
// CI) they can take a while to show, so each gets up to `timeout` — waiting
// on whichever comes first, a screen to click or the app opening its
// socket, so a page that's past them already (a reload once the choice is
// saved) isn't held up.
// The new app (from Nov 2026) first, then the old one's, in case either is
// served.
const GENDER = "button.gender-option--male, .gender-item.male";
const TERMS = "button.terms-of-service__button, .terms-actions button, .terms-actions div";

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

// The login form in the new app (from Nov 2026): "Sign in" in the nav bar
// opens a sign-up card, whose "Already have an account? Sign in" switches
// it to the login form.
const LOGIN_FORM = "form.auth-male-login";
const SIGN_IN_TOGGLE = ".auth-male-email__toggle .link";
const STEPS = {
  openMenu: "div.login-button",
  // Either the sign-up card's "Sign in" link, or the login form already.
  openSignIn: `${SIGN_IN_TOGGLE}, ${LOGIN_FORM}`,
  email: `${LOGIN_FORM} input[type="email"]`,
  password: `${LOGIN_FORM} input[type="password"]`,
  submit: `${LOGIN_FORM} button[type="submit"]`,
};
const STEP_TIMEOUT = 10000;
// Where a failed step's screenshot goes, to see what coomeet showed instead.
const FAILED_SHOT = "coomeet-login-failed.png";

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
      const shown = await page
        .evaluate(() =>
          [...document.querySelectorAll(".modal-card, .auth-male, [class*=terms], [class*=popup]")]
            .filter((e) => e.getBoundingClientRect().width)
            .map((e) => `${e.className}`.slice(0, 60))
            .slice(0, 5)
            .join(" | "),
        )
        .catch(() => "");
      await page.screenshot({ path: FAILED_SHOT }).catch(() => {});
      console.warn(
        `⚠️ Login step "${name}" failed (${error.message}; showing: ${shown || "nothing"}; screenshot ${FAILED_SHOT}) — going on as a guest`,
      );
      return false;
    }
  };
  // The terms can still be up (they sometimes come late) and would take the
  // click meant for "Sign in".
  await passIntro(page, 3000);
  const done =
    // Clicked before the app is ready, "Sign in" does nothing — so it's
    // clicked again until the card opens.
    (await step("openMenu", async (s) => {
      for (let attempt = 1; ; attempt++) {
        // The terms can show up seconds after the page loads, over it all.
        if (await page.$(TERMS)) await page.click(TERMS).catch(() => {});
        await page.click(s);
        const opened = await page
          .waitForSelector(".auth-male", { visible: true, timeout: 3000 })
          .then(() => true, () => false);
        if (opened) return;
        if (attempt >= 4) throw new Error("the sign-in card didn't open");
      }
    })) &&
    (await step("openSignIn", async () => {
      if (!(await page.$(LOGIN_FORM))) await page.click(SIGN_IN_TOGGLE);
    })) &&
    (await step("email", (s) => page.type(s, email))) &&
    (await step("password", (s) => page.type(s, password))) &&
    (await step("submit", async (s) => {
      await page.click(s);
      // Signed in, the card closes; refused, it stays with a message.
      const closed = await page
        .waitForSelector(LOGIN_FORM, { hidden: true, timeout: 10000 })
        .then(() => true, () => false);
      if (!closed) {
        const said = await page
          .$eval(LOGIN_FORM, (f) => f.innerText.replace(/\s+/g, " ").trim().slice(0, 200))
          .catch(() => "");
        throw new Error(`coomeet didn't take the login — the form still says: ${said}`);
      }
    }));
  // The app takes a moment to take the login in before the page is reloaded.
  await wait(1000);
  return done;
}
