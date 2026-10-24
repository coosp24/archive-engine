# archive-engine

Archives the stories, names, avatars and faces of models on video chat sites into Supabase, once an hour. archive-web shows what it keeps.

## Running it

```sh
npm install
npm start                         # every site, logged in with its primary account
npm start -- --site=coomeet --limit=20 --guest
npm start -- --faces-only --faces-limit=50
npm run check                     # lint and unit tests
```

`.env` holds `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, plus optionally `BROWSER_PATH`, `HEADLESS=true` and `ENV=development` (which logs every story). `src/cli.js` lists every option.

On GitHub, `.github/workflows/archive.yml` runs it every hour, dispatched by Supabase (`supabase/shared/schedule.sql`). `check.yml` lints and tests every push.

## Layout

```
index.js                 entry point: node .
src/
  cli.js                 options, and a run per site
  core/                  what every site shares
    run.js               one site's run: browser, account, report
    browser.js           launching the browser, setting up a page
    batch-saver.js       saving in the background, in batches
    retry.js, pool.js, log.js
  db/                    the shared tables (runs, accounts), and each site's faces
  faces/                 face detection and fingerprints (ONNX), and the indexer
  sites/
    index.js             the list of sites, and what a site provides
    coomeet/
      index.js           reading its stories feed
      feed.page.js       runs inside coomeet's page: its websocket
      story.js           a story as coomeet sends it → as the archive keeps it
      saver.js           what's new, and what's only seen again
      session.js         its intro screens and login
      store.js           its tables (coomeet_*)
    flirtbees/           its API, spoken directly: no browser
      index.js           reading its stories feed
      api.js             login (or a guest token), requests
      story.js           a story as flirtbees sends it → as the archive keeps it
      store.js           its tables (flirtbees_*)
    mirami/              its API as a guest, no browser; its stories are reels
      index.js           reading its reels, its girls lists and each girl's profile
      api.js             a guest token from its socket, requests
      girl.js            a reel and a profile as mirami sends them → as the archive keeps them
      store.js           its tables (mirami_*)
    luckycrush/          a signed-up man's recommended models, in a browser (Cloudflare)
      index.js           signing in, reading the recommendations a few times
      model.js           a recommended model → as the archive keeps her
      store.js           its tables (luckycrush_*)
    flirtify/            its API and page data as a guest, no browser; links expire in 2 days
      index.js           reading its feed, live rooms, age categories and every profile
      api.js             requests, and SvelteKit's page data (__data.json)
      model.js           a model, her profile and stories → as the archive keeps them
      store.js           its tables (flirtify_*)
models/                  the face models (InsightFace buffalo_s)
supabase/                the database: shared/ and one folder per site
test/                    unit tests (node --test)
```

## Adding a site

1. `src/sites/<site>/`: an `index.js` exporting `{ id, method, browser, archive, faces }`. See `src/sites/index.js` for what each does. coomeet is an example of reading a site in a browser, flirtbees of talking to a site's API directly.
2. List it in `src/sites/index.js`.
3. `supabase/<site>/`: its own tables and functions, named `<site>_…`. See `supabase/README.md`.
4. Its login, if it has one, in the `accounts` table with `site = '<site>'`.
