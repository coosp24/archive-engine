-- The scrape log, shared by every site: one row per engine run, with the
-- report it prints at the end. Run in the Supabase SQL editor, after
-- setup.sql (see supabase/README.md). Safe to re-run.
--
-- Everyone can read it (the site's analysis page shows it); only the engine
-- writes, with the secret key, which bypasses RLS. It never holds the
-- account's email — only whether the run was logged in.

create table if not exists public.runs (
  id bigint generated always as identity primary key,
  -- Which site was archived: its id in the engine's src/sites/ ("coomeet").
  site text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  -- 'ok', or 'failed' with what went wrong in `error`.
  status text not null check (status in ('ok', 'failed')),
  error text,
  -- 'github' for the scheduled runs, 'local' for one run by hand.
  source text not null check (source in ('github', 'local')),
  -- How the site was read, as the site names it (coomeet: 'feed', its
  -- server's stories feed; 'slider', clicking through its pages, in old
  -- runs).
  method text not null,
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
  data_mb numeric,
  -- What the run fingerprinted for face search afterwards.
  faces_scanned integer,
  faces_found integer
);

create index if not exists runs_started_at_idx on public.runs (started_at desc);

alter table public.runs enable row level security;

drop policy if exists "Anyone can read runs" on public.runs;
create policy "Anyone can read runs" on public.runs
  for select to anon, authenticated using (true);
