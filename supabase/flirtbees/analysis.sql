-- The site's analysis page for flirtbees: read-only summaries of its archive,
-- worked out here so the page fetches a few dozen numbers instead of every
-- row. Run in the Supabase SQL editor, after schema.sql (see
-- supabase/README.md). Safe to re-run.
--
-- The page shows the archive's totals, what it archived each day lately,
-- accounts by year created and the models with the most stories, names and
-- avatars, all time. (Its scrape log reads the shared runs table directly.)

/* ===================== HEADLINE ===================== */

-- The archive as it is now: { models, stories, names, avatars, renamed,
-- new_avatar, last_run }.
create or replace function public.flirtbees_analysis_totals()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'models', (select count(*) from flirtbees_models),
    'stories', (select count(*) from flirtbees_stories),
    'names', (select count(*) from flirtbees_names),
    'avatars', (select count(*) from flirtbees_avatars),
    -- Models that have had more than one name, or avatar.
    'renamed', (select count(*) from (select 1 from flirtbees_names group by model_id having count(*) > 1) x),
    'new_avatar', (select count(*) from (select 1 from flirtbees_avatars group by model_id having count(*) > 1) x),
    'last_run', (select max(last_seen_at) from flirtbees_models)
  );
$$;

/* ===================== PER DAY ===================== */

-- What the archive gained each day over the last p_days days (at most 90),
-- up to today, as days in p_tz: new models, stories, names and avatars, by
-- when the engine first saw them. Every day is listed, nothing new or not.
create or replace function public.flirtbees_analysis_daily(p_days int default 30, p_tz text default 'UTC')
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
  m as (select (first_seen_at at time zone tz)::date k, count(*) n from flirtbees_models
        where first_seen_at >= since group by 1),
  s as (select (first_seen_at at time zone tz)::date k, count(*) n from flirtbees_stories
        where first_seen_at >= since group by 1),
  nm as (select (first_seen_at at time zone tz)::date k, count(*) n from flirtbees_names
         where first_seen_at >= since group by 1),
  a as (select (first_seen_at at time zone tz)::date k, count(*) n from flirtbees_avatars
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
create or replace function public.flirtbees_analysis_account_years(p_tz text default 'UTC')
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
  from flirtbees_models group by 1 order by 1;
end;
$$;

-- The top p_limit (at most 25) models by each measure, all time:
--   stories  stories she's published
--   names    names she's had (more than one)
--   avatars  avatars she's had (more than one)
-- Each as [{ id, name, avatar, value }].
create or replace function public.flirtbees_analysis_top(p_limit int default 10)
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
        from (select model_id, count(*) value from flirtbees_stories
              group by 1 order by 2 desc, 1 limit n) x
        join flirtbees_models m on m.id = x.model_id
      ) t
    ),
    'names', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from flirtbees_names
              group by 1 having count(*) > 1 order by 2 desc, 1 limit n) x
        join flirtbees_models m on m.id = x.model_id
      ) t
    ),
    'avatars', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from flirtbees_avatars
              group by 1 having count(*) > 1 order by 2 desc, 1 limit n) x
        join flirtbees_models m on m.id = x.model_id
      ) t
    )
  );
end;
$$;

/* ===================== ACCESS ===================== */

-- Read-only, and only over tables anyone can read already.
grant execute on function public.flirtbees_analysis_totals() to anon, authenticated;
grant execute on function public.flirtbees_analysis_daily(int, text) to anon, authenticated;
grant execute on function public.flirtbees_analysis_account_years(text) to anon, authenticated;
grant execute on function public.flirtbees_analysis_top(int) to anon, authenticated;
