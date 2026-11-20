-- The site's analysis page for coomeet: read-only summaries of its archive,
-- worked out here so the page fetches a few dozen numbers instead of every
-- row. Run in the Supabase SQL editor, after schema.sql (see
-- supabase/README.md). Safe to re-run.
--
-- The page shows the archive's totals, what it archived each day lately,
-- accounts by year created and the models with the most stories, names and
-- avatars, all time. (Its scrape log reads the shared runs table directly.)
--
-- coomeet's tables are too big to count on every visit within the public
-- key's 3-second limit (counting its ~740k stories alone took 3-11 s on the
-- free plan's compute), so the counting is done ahead of time, into the
-- three summaries below, and the page's functions read those. pg_cron
-- refreshes them at :10 and :40 — after the hourly coomeet run, which starts
-- at :00 and takes ~3 minutes — so they're at most half an hour behind.

/* ===================== SUMMARIES ===================== */

-- What the archive gained in each 15 minutes, by when the engine first saw
-- it. 15 minutes rather than an hour, so any time zone's days (some are
-- :30 or :45 off UTC) are made of whole buckets.
create materialized view if not exists public.coomeet_analysis_quarters as
select bucket,
       sum(models)::bigint models, sum(stories)::bigint stories,
       sum(names)::bigint names, sum(avatars)::bigint avatars
from (
  select date_bin('15 minutes', first_seen_at, timestamptz '2000-01-01 00:00+00') bucket,
         count(*) models, 0::bigint stories, 0::bigint names, 0::bigint avatars
  from coomeet_models group by 1
  union all
  select date_bin('15 minutes', first_seen_at, timestamptz '2000-01-01 00:00+00'), 0, count(*), 0, 0
  from coomeet_stories group by 1
  union all
  select date_bin('15 minutes', first_seen_at, timestamptz '2000-01-01 00:00+00'), 0, 0, count(*), 0
  from coomeet_names group by 1
  union all
  select date_bin('15 minutes', first_seen_at, timestamptz '2000-01-01 00:00+00'), 0, 0, 0, count(*)
  from coomeet_avatars group by 1
) x
group by bucket;
create unique index if not exists coomeet_analysis_quarters_bucket_idx
  on public.coomeet_analysis_quarters (bucket);

-- Each model's stories, names and avatars, all time.
create materialized view if not exists public.coomeet_analysis_model_counts as
select m.id model_id,
       coalesce(s.n, 0)::bigint stories, coalesce(nm.n, 0)::bigint names, coalesce(a.n, 0)::bigint avatars
from coomeet_models m
left join (select model_id, count(*) n from coomeet_stories group by 1) s on s.model_id = m.id
left join (select model_id, count(*) n from coomeet_names group by 1) nm on nm.model_id = m.id
left join (select model_id, count(*) n from coomeet_avatars group by 1) a on a.model_id = m.id;
create unique index if not exists coomeet_analysis_model_counts_model_id_idx
  on public.coomeet_analysis_model_counts (model_id);
create index if not exists coomeet_analysis_model_counts_stories_idx
  on public.coomeet_analysis_model_counts (stories desc, model_id);
create index if not exists coomeet_analysis_model_counts_names_idx
  on public.coomeet_analysis_model_counts (names desc, model_id);
create index if not exists coomeet_analysis_model_counts_avatars_idx
  on public.coomeet_analysis_model_counts (avatars desc, model_id);

-- The archive's totals: one row (`one` only gives it the unique index a
-- concurrent refresh needs).
create materialized view if not exists public.coomeet_analysis_counts as
select 1 one,
       (select count(*) from coomeet_models) models,
       (select count(*) from coomeet_stories) stories,
       (select count(*) from coomeet_names) names,
       (select count(*) from coomeet_avatars) avatars,
       -- Models that have had more than one name, or avatar.
       (select count(*) from (select 1 from coomeet_names group by model_id having count(*) > 1) x) renamed,
       (select count(*) from (select 1 from coomeet_avatars group by model_id having count(*) > 1) x) new_avatar;
create unique index if not exists coomeet_analysis_counts_one_idx
  on public.coomeet_analysis_counts (one);

-- Recounts all three. Concurrently, so the page keeps reading the last
-- counts while the new ones are worked out.
create or replace function public.coomeet_analysis_refresh()
returns void
language plpgsql
set search_path = public
as $$
begin
  refresh materialized view concurrently coomeet_analysis_quarters;
  refresh materialized view concurrently coomeet_analysis_model_counts;
  refresh materialized view concurrently coomeet_analysis_counts;
end;
$$;

-- At :10 and :40. Re-running this file replaces the job.
select cron.schedule('coomeet-analysis-refresh', '10,40 * * * *', 'select public.coomeet_analysis_refresh()');

/* ===================== HEADLINE ===================== */

-- The archive as it is now: { models, stories, names, avatars, renamed,
-- new_avatar, last_run }. last_run is read live: it's cheap.
create or replace function public.coomeet_analysis_totals()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'models', c.models,
    'stories', c.stories,
    'names', c.names,
    'avatars', c.avatars,
    'renamed', c.renamed,
    'new_avatar', c.new_avatar,
    'last_run', (select max(last_seen_at) from coomeet_models)
  )
  from coomeet_analysis_counts c;
$$;

/* ===================== PER DAY ===================== */

-- What the archive gained each day over the last p_days days (at most 90),
-- up to today, as days in p_tz: new models, stories, names and avatars, by
-- when the engine first saw them. Every day is listed, nothing new or not.
create or replace function public.coomeet_analysis_daily(p_days int default 30, p_tz text default 'UTC')
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
  x as (select (q.bucket at time zone tz)::date k,
               sum(q.models)::bigint m, sum(q.stories)::bigint s,
               sum(q.names)::bigint nm, sum(q.avatars)::bigint a
        from coomeet_analysis_quarters q
        where q.bucket >= since
        group by 1)
  select d.k, coalesce(x.m, 0), coalesce(x.s, 0), coalesce(x.nm, 0), coalesce(x.a, 0)
  from d
  left join x on x.k = d.k
  order by d.k;
end;
$$;

/* ===================== MODELS ===================== */

-- How many models' accounts were created each year (account_created_at is
-- the id itself) in p_tz — any IANA time zone, e.g. 'Africa/Cairo' — all time.
-- Accounts whose id isn't a time (made since 2026-10-28) are one row with no
-- year.
create or replace function public.coomeet_analysis_account_years(p_tz text default 'UTC')
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
  from coomeet_models group by 1 order by 1;
end;
$$;

-- The top p_limit (at most 25) models by each measure, all time:
--   stories  stories she's published
--   names    names she's had (more than one)
--   avatars  avatars she's had (more than one)
-- Each as [{ id, name, avatar, value }].
create or replace function public.coomeet_analysis_top(p_limit int default 10)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  n int := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  -- From the per-model counts (see SUMMARIES); her name and avatar live.
  return jsonb_build_object(
    'stories', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, stories value from coomeet_analysis_model_counts
              order by stories desc, model_id limit n) x
        join coomeet_models m on m.id = x.model_id
      ) t
    ),
    'names', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, names value from coomeet_analysis_model_counts
              where names > 1 order by names desc, model_id limit n) x
        join coomeet_models m on m.id = x.model_id
      ) t
    ),
    'avatars', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, avatars value from coomeet_analysis_model_counts
              where avatars > 1 order by avatars desc, model_id limit n) x
        join coomeet_models m on m.id = x.model_id
      ) t
    )
  );
end;
$$;

/* ===================== ACCESS ===================== */

-- Read-only, and only over tables anyone can read already. The summaries
-- are only counts of those tables. The refresh is for pg_cron (the database
-- owner) only.
grant select on public.coomeet_analysis_quarters, public.coomeet_analysis_model_counts,
  public.coomeet_analysis_counts to anon, authenticated;
revoke all on function public.coomeet_analysis_refresh() from public, anon, authenticated;
grant execute on function public.coomeet_analysis_totals() to anon, authenticated;
grant execute on function public.coomeet_analysis_daily(int, text) to anon, authenticated;
grant execute on function public.coomeet_analysis_account_years(text) to anon, authenticated;
grant execute on function public.coomeet_analysis_top(int) to anon, authenticated;
