-- The scrape log: one row per engine run, with the report it prints at the
-- end. Run once in the Supabase SQL editor. Safe to re-run.
--
-- Everyone can read it (the site's analysis page shows it); only the engine
-- writes, with the secret key, which bypasses RLS. It never holds the
-- account's email — only whether the run was logged in.

create table if not exists public.runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  -- 'ok', or 'failed' with what went wrong in `error`.
  status text not null check (status in ('ok', 'failed')),
  error text,
  -- 'github' for the scheduled runs, 'local' for one run by hand.
  source text not null check (source in ('github', 'local')),
  -- 'feed' (coomeet's server) or 'slider' (clicking through the page).
  method text not null check (method in ('feed', 'slider')),
  -- Null when the run failed before it got that far.
  guest boolean,
  -- --limit=N, for a test run; null for a full one.
  story_limit integer,
  stories_found integer,
  owner_unknown integer,
  saved integer,
  skipped integer,
  failed_saves integer,
  new_models integer,
  new_stories integer,
  new_names integer,
  new_avatars integer,
  data_mb numeric
);

create index if not exists runs_started_at_idx on public.runs (started_at desc);

alter table public.runs enable row level security;

drop policy if exists "Anyone can read runs" on public.runs;
create policy "Anyone can read runs" on public.runs
  for select to anon, authenticated using (true);
