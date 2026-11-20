# luckycrush: why every run fails since 2026-10-23

Notes from investigating the luckycrush runs, written 2026-11-20. Tested
live from a local machine (Chrome via puppeteer-core), without signing in.

## What happens

- Every luckycrush run has failed since **2026-10-23 15:16 UTC**: 588 runs
  by 2026-11-20, all with `Failed to fetch`, about 20 seconds in, right after
  `🔑 Logging in as …`. (One earlier failure on 2026-10-22,
  `malformed array literal: "model"`, is unrelated.)
- It went unnoticed while every site ran in one hourly job, where it was a
  single line in a long log.

## Why

**luckycrush's API refuses browsers that identify as automated.**

- Loaded the way the engine launches Chrome (puppeteer's defaults, which
  mark the browser as automated: `navigator.webdriver` is true), luckycrush's
  **own** page fails its own API calls: after choosing a gender it ends on
  `https://www.luckycrush.com/?fallback=1`, the site's error path
  (`navigateToFallback`).
- The same Chrome without the automation markers: `GET /buurn/public/config`
  200, `POST /buurn/public/visitor/events` 200, and the app loads
  (`Version: 7-9-173-ab1eb4a5`).
- The page also logs invisible `%c%o font-size:0` messages to the console:
  a common way of detecting automation tools.
- The refusals carry no `Access-Control-Allow-Origin` header, so the browser
  reports them as CORS errors, and `fetch` from inside the page throws
  `Failed to fetch`: the engine never sees a status or a message.

Requests from inside luckycrush's page, as the engine launches Chrome:

| Request | Result |
|---|---|
| `GET /buurn/public/init`, without cookies | HTTP 200 |
| `GET /buurn/public/init`, `credentials: "include"` | blocked (no CORS header) |
| `GET /buurn/r/model-recommendations`, with cookies | blocked |
| `POST /buurn/public/signin`, with cookies (with or without the CSRF token) | blocked |

## Also changed (secondary)

- The landing page now calls `/buurn/public/init?…&v=<app version>` (the
  version, e.g. `7-9-173-ab1eb4a5`, and a timestamp `t`, plus a device
  fingerprint `fp` / `fpscore` when it wants one). Its answer includes a
  **CSRF token** (`ctk`, kept as `window.ctk`), and later requests send it as
  a `CSRF-Token` header (`POST /buurn/public/visitor/sexe` does, with a JSON
  body). The engine sends neither (`src/sites/luckycrush/index.js`: a form
  POST to `/buurn/public/signin`, then `/buurn/r/model-recommendations`).
- The site config is `window.lc_siteConfig`; its `apiBaseUrl` is still
  `https://api-public.luckycrush.com`.
- Whether `/buurn/public/signin` and `/buurn/r/model-recommendations` are
  still the paths, and what the sign-in body looks like now, wasn't checked:
  the app that holds that code only loads in a browser luckycrush accepts.

## Where it stands

- Getting the runs working again means a browser luckycrush doesn't take for
  an automated one, which is getting past its bot detection. That's left
  to the owner: not done here.
- Until then the luckycrush step in the hourly chain fails every run (it
  doesn't stop the chain: flirtify still starts after it).
- The models already archived (1,376) stay on the site.
