# coomeet: what changed on 2026-11-18, and what works now

Notes from investigating the drop from ~9,000 stories per run to ~50, written
2026-11-20. Everything here was tested live against coomeet from a local
machine (headless Chrome via puppeteer-core, the engine's own feed script).

## What happened

- Up to run #3290 (2026-11-18 06:00 UTC) every hourly run found ~9,000–9,450
  stories in 8–10 minutes. Run #3295 (07:00) found 3,621. From #3300 (08:00)
  every run found 10–86, in about a minute. The 00:00 and 01:00 runs that day
  already showed it briefly (379 and 1,356).
- The feed itself didn't shrink: the last good runs saved 750–2,400 new
  stories an hour.
- coomeet shipped a new front end and changed how the stories feed treats
  guests and free accounts at the same time.

## coomeet's feed now

- A fresh session gets one batch of **10** stories (not 20), then
  `storyLockExpirationTime` (a 300 s lock) and 5 stories a batch.
- While locked, marking stories viewed (`StoryLook`) is accepted (every reply
  `{}`) but doesn't move the feed: each batch is a **shuffled draw from a pool
  of ~100 stories**, with heavy repeats. 53 batches gave 95 different stories.
  Reply data also has a new `more: 0`.
- The engine used to stop at the first batch of only stories already seen,
  hence ~50–85 a run. Even reading on, a run tops out at ~100.
- **The lock follows the IP / device, not the session.** A brand-new browser
  profile minutes later started with the lock already running (it's in the
  `Authorization` message on connect). Back-to-back test runs keep renewing
  it; wait 5+ minutes between tests.
- **A signed-in free account is limited exactly like a guest.** Tested with
  the login working (`statusReg 2`) and no lock at the start: 10 stories,
  then the lock, then the same pool (109 stories). The app's code checks
  `isPremium` around the lock, so a paid account may differ (untested).
- `StoryBatch { limit, rule: "top" }` (the "top" list) locks the same way
  once stories are marked viewed.

## What works

### 1. `GetAuthorStory { womanId }`: every known model's current story

- Answers `data.story` (same shape as a feed story) or `data.code 402`
  ("Story not found") when she has none up.
- **Not held back by the feed lock**, and asking doesn't touch the lock.
- All 18,833 known models, 25 requests in flight: 1.5–2.5 minutes, coomeet
  never slowed down (0 replies over 3 s). ~9,300 had a story up, matching
  the old ~9,400 a run.
- Built into the engine (`src/sites/coomeet/`): the run reads the feed (for
  new models), then asks every known model the feed didn't bring.
  Run #3608 (2026-11-20 19:13 UTC): 9,287 found, 8,825 new stories, 2m 29s.
- Limits: only her **latest** story (two posted between runs → the earlier
  is missed; models posted ~2.8 a day on the last good day), and only models
  **already in the archive**: it can't discover new ones.

### 2. Polling `StoryBatch` without ever sending `StoryLook`: a live stream

- **Never locks**: 153 batches in 3 minutes, all 10 stories, lock 0.
- Returns stories as they're published: 77 of 83 stories seen in 3 minutes
  were published during the poll, each seen within a minute (~1,500/hour,
  coomeet's posting rate).
- This is the only way found to get **new models**, since anyone who posts
  shows up. But it only sees what's posted while it polls, so it has to run
  for most of each hour to matter. **Not built yet.** Open question: how long
  each run polls (GitHub Actions minutes).

### New models: what's at stake

| Days | New models a day |
|---|---|
| Nov 12–17 (before) | 109–172 |
| Nov 19–20 (after) | 1–9 |

## Dead ends

- `UserSearch { name }` searches only your own contacts (empty for a guest).
- `ViewTop { code: "day" | "week" | "month" }` (the leaderboard) answers
  `ErrorRequest` code 132 to a guest.
- Model ids are creation times (`account_created_at` = id / 10⁴ seconds,
  0.1 ms resolution): 10,000 possible ids a second, not guessable.

## The new front end (selectors)

- Intro: gender `button.gender-option--male` (was `.gender-item.male`),
  terms `button.terms-of-service__button` (was `.terms-actions …`). The terms
  box can appear seconds after load, over everything.
- Sign-in: `div.login-button` opens a sign-up card (it needs re-clicking if
  the app isn't ready yet). `.auth-male-email__toggle .link` ("Already have
  an account? Sign in") switches to `form.auth-male-login`
  (`input[type=email]`, `input[type=password]`, `button[type=submit]`). On
  success the form closes.
- `Authorization` (first socket message) carries `statusReg` (0 = guest,
  2 = signed in) and `storyLockExpirationTime`. The engine now logs it as
  `🪪 coomeet: …` and records `runs.guest` from it.

## Commands seen in the app's code (main.js and its chunks)

Stories: `StoryBatch`, `StoryLook`, `GetAuthorStory`, `StoryLikedList`,
`StoryContactList`, `UpdateStoryLike`, `UpdateStoryDislike`, `StoryAbuse`,
`StoryBlockLook`, `StoryNotification`, `StoryAutoDeleted`. Contacts:
`ContactList`, `UserSearch`, `GetContact`, `ContactInfo`, `OnlineStatus`, … .
Top: `ViewTop`, `ShowTopBonus`. Each is sent over the app's websocket
(`wspr.coomeet.com`) as `{ event: { Cmd, Cid }, data }`.

## Engine changes (uncommitted as of writing)

- `session.js`: new intro and sign-in selectors (old intro ones kept as
  fallbacks), terms cleared before each sign-in click, "Sign in" re-clicked
  until the card opens, login confirmed by the form closing, a failed step
  saves `coomeet-login-failed.png` and says what was showing.
- `feed.page.js`: records `statusReg` / lock from `Authorization`; adds
  `authorStory()` (GetAuthorStory).
- `index.js`: logs who coomeet sees (`🪪`); the feed stops after 8 stale
  batches in a row instead of 1; then asks every known model directly
  (25 at a time, 10 s timeout, 3 attempts).
