-- What every site's tables and functions rely on: extensions, the engine's
-- time limit, and small helpers. Run first, in the Supabase SQL editor (see
-- supabase/README.md). Safe to re-run.

-- Fingerprints for face search (supabase/<site>/faces.sql).
create extension if not exists vector with schema extensions;

-- The engine's own calls (its secret key) may take up to a minute: saving a
-- batch of faces means adding them to the index, which on the free plan's
-- throttled disk can take several seconds. The site's key keeps its limit.
-- (Should Supabase not allow it, the rest goes ahead without it.)
do $$
begin
  execute 'alter role service_role set statement_timeout = ''60s''';
exception when others then
  raise notice 'The engine''s time limit stays as it was: %', sqlerrm;
end;
$$;
notify pgrst, 'reload config';

-- How many story faces a model keeps, and how alike (0–1) a new one may be
-- to one she has and still be kept: past it, it's the same look again.
create or replace function public.faces_story_cap() returns int
language sql immutable as $$ select 10 $$;
create or replace function public.faces_same_look() returns real
language sql immutable as $$ select 0.8::real $$;

-- The viewer's time zone, by its IANA name ("Africa/Cairo"), if Postgres
-- knows it; UTC if it doesn't, so an unusual name can't break the analysis
-- page.
create or replace function public.analysis_tz(p_tz text)
returns text
language sql
stable
as $$
  select coalesce((select name from pg_timezone_names where name = p_tz limit 1), 'UTC');
$$;

grant execute on function public.analysis_tz(text) to anon, authenticated;
