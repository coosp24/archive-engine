-- The site's analysis page: read-only summaries of the archive, worked out
-- here so the page fetches a few dozen numbers instead of every row. Run
-- once in the Supabase SQL editor, after runs.sql. Safe to re-run.
--
-- The page shows the archive's totals, what it archived each day lately,
-- accounts by year created and the models with the most stories, names and
-- avatars, all time. (Its scrape log reads the runs table directly.)

/* ===================== NO LONGER USED ===================== */

-- From earlier versions of the page, which also charted the archive over
-- time and when models are online: gone, with the indexes only they used.
drop function if exists public.analysis_timeline(timestamptz, text, text);
drop function if exists public.analysis_timeline(timestamptz, text);
drop function if exists public.analysis_week_hours(timestamptz, text);
drop function if exists public.analysis_week_hours(timestamptz);
drop function if exists public.analysis_top(timestamptz, int);
drop function if exists public.analysis_sightings(timestamptz);
drop function if exists public.analysis_check_range(timestamptz, text);

drop index if exists public.models_first_seen_at_idx;
drop index if exists public.stories_first_seen_at_idx;
drop index if exists public.stories_published_at_idx;
drop index if exists public.names_first_seen_at_idx;
drop index if exists public.avatars_first_seen_at_idx;
drop index if exists public.online_sessions_last_seen_at_idx;

/* ===================== HELPERS ===================== */

-- The site's first versions only allowed UTC and Cairo.
drop function if exists public.analysis_check_tz(text);

-- The viewer's time zone, by its IANA name ("Africa/Cairo"), if Postgres
-- knows it; UTC if it doesn't, so an unusual name can't break the page.
create or replace function public.analysis_tz(p_tz text)
returns text
language sql
stable
as $$
  select coalesce((select name from pg_timezone_names where name = p_tz limit 1), 'UTC');
$$;

/* ===================== HEADLINE ===================== */

-- The archive as it is now: { models, stories, names, avatars, renamed,
-- new_avatar, last_run }.
create or replace function public.analysis_totals()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'models', (select count(*) from models),
    'stories', (select count(*) from stories),
    'names', (select count(*) from names),
    'avatars', (select count(*) from avatars),
    -- Models that have had more than one name, or avatar.
    'renamed', (select count(*) from (select 1 from names group by model_id having count(*) > 1) x),
    'new_avatar', (select count(*) from (select 1 from avatars group by model_id having count(*) > 1) x),
    'last_run', (select max(last_seen_at) from models)
  );
$$;

/* ===================== PER DAY ===================== */

-- What the archive gained each day over the last p_days days (at most 90),
-- up to today, as days in p_tz: new models, stories, names and avatars, by
-- when the engine first saw them. Every day is listed, nothing new or not.
create or replace function public.analysis_daily(p_days int default 30, p_tz text default 'UTC')
returns table (day date, models bigint, stories bigint, names bigint, avatars bigint)
language plpgsql
stable
set search_path = public
as $$
declare
  tz text := analysis_tz(p_tz);
  today date := (now() at time zone tz)::date;
  first_day date := today - (least(greatest(coalesce(p_days, 30), 1), 90) - 1);
  since timestamptz := first_day::timestamp at time zone tz;
begin
  return query
  with d as (select generate_series(first_day, today, interval '1 day')::date k),
  m as (select (first_seen_at at time zone tz)::date k, count(*) n from models
        where first_seen_at >= since group by 1),
  s as (select (first_seen_at at time zone tz)::date k, count(*) n from stories
        where first_seen_at >= since group by 1),
  nm as (select (first_seen_at at time zone tz)::date k, count(*) n from names
         where first_seen_at >= since group by 1),
  a as (select (first_seen_at at time zone tz)::date k, count(*) n from avatars
        where first_seen_at >= since group by 1)
  select d.k, coalesce(m.n, 0), coalesce(s.n, 0), coalesce(nm.n, 0), coalesce(a.n, 0)
  from d
  left join m on m.k = d.k
  left join s on s.k = d.k
  left join nm on nm.k = d.k
  left join a on a.k = d.k
  order by d.k;
end;
$$;

/* ===================== MODELS ===================== */

-- How many models' accounts were created each year (account_created_at is
-- the id itself) in p_tz — any IANA time zone, e.g. 'Africa/Cairo' — all time.
create or replace function public.analysis_account_years(p_tz text default 'UTC')
returns table (year int, models bigint)
language plpgsql
stable
set search_path = public
as $$
declare
  tz text := analysis_tz(p_tz);
begin
  return query
  select extract(year from account_created_at at time zone tz)::int, count(*)
  from models group by 1 order by 1;
end;
$$;

-- The top p_limit (at most 25) models by each measure, all time:
--   stories  stories she's published
--   names    names she's had (more than one)
--   avatars  avatars she's had (more than one)
-- Each as [{ id, name, avatar, value }].
create or replace function public.analysis_top(p_limit int default 10)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  n int := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  return jsonb_build_object(
    'stories', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from stories
              group by 1 order by 2 desc, 1 limit n) x
        join models m on m.id = x.model_id
      ) t
    ),
    'names', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from names
              group by 1 having count(*) > 1 order by 2 desc, 1 limit n) x
        join models m on m.id = x.model_id
      ) t
    ),
    'avatars', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from avatars
              group by 1 having count(*) > 1 order by 2 desc, 1 limit n) x
        join models m on m.id = x.model_id
      ) t
    )
  );
end;
$$;

/* ===================== ACCESS ===================== */

-- Read-only, and only over tables anyone can read already.
grant execute on function public.analysis_totals() to anon, authenticated;
grant execute on function public.analysis_tz(text) to anon, authenticated;
grant execute on function public.analysis_daily(int, text) to anon, authenticated;
grant execute on function public.analysis_account_years(text) to anon, authenticated;
grant execute on function public.analysis_top(int) to anon, authenticated;
