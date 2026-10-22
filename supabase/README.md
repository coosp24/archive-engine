# The archive's database

Supabase (Postgres). Each file is run in the Supabase SQL editor, and each is safe to re-run.

## Layout

- `shared/`: what every site uses.
  - `setup.sql`: extensions, the engine's time limit, small helpers.
  - `runs.sql`: the scrape log, one row per run, with its `site`.
  - `accounts.sql`: the accounts the engine logs in with, per `site`.
  - `schedule.sql`: the hourly run (pg_cron → GitHub Actions).
- `<site>/`: one site's own tables and functions, all named `<site>_…` (`coomeet_models`, `coomeet_record_stories`, …). Each site returns different data, so each keeps its own tables.
  - `schema.sql`: its models, names, avatars and stories, and the functions the engine saves through.
  - `faces.sql`: its faces, for search by photo.
  - `analysis.sql`: the summaries the site's analysis page reads.

## From scratch

Run, in order:

1. `shared/setup.sql`
2. `shared/runs.sql`
3. `shared/accounts.sql`
4. `coomeet/schema.sql`
5. `coomeet/faces.sql`
6. `coomeet/analysis.sql`
7. `flirtbees/schema.sql`
8. `shared/schedule.sql` (after storing the GitHub token it describes)

## Adding a site

Copy `coomeet/` to `<site>/`, rename every `coomeet_` to `<site>_`, and shape its tables to what that site sends. Then add the engine's side in `src/sites/<site>/` (see `src/sites/index.js`).
