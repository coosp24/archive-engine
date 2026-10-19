import { click, type, wait } from "./helpers.js";
import { getPage } from "./context.js";

// The same login as cooscrap-engine/util/form-logger.js. Credentials come
// from the accounts table (api/account.js) — never from the code.
export const login = async (email, password) => {
  const page = getPage();
  await click(
    page,
    "#application-wrapper > div.coomeet-chat > div.chat-header > div.signed-in-user > div > div.ui-user-avatar > div",
  );
  await click(
    page,
    "#application-wrapper > div.coomeet-chat > div.popup-overlay-wrapper > div.popup-overlay.visible > div > div.popup-overlay-content > div > div.ui-scroll-area > div > div.popup-component > div > div > div > form > div.form-content > div.form-content__footer > div > span",
  );

  await type(page, 'input[type="email"]', email);

  await type(page, 'input[type="password"]', password);

  await click(
    page,
    "#application-wrapper > div.coomeet-chat > div.popup-overlay-wrapper > div.popup-overlay.visible > div > div.popup-overlay-content > div > div.ui-scroll-area > div > div.popup-component > div > div > form > div.form-actions > button",
  );
  await wait(1000);
};
