-- The site's analysis page: read-only summaries of the archive, worked out
-- here so the page fetches a few hundred numbers instead of every row. Run
-- once in the Supabase SQL editor, after online.sql and runs.sql. Safe to
-- re-run.
--
-- A range is everything since p_since, counted in buckets of an hour or a
-- day (p_bucket 'hour' | 'day'). Days, hours of the day and weekdays are
-- counted in p_tz — the viewer's time zone, 'UTC' or 'Africa/Cairo' — so a
-- day is her day, through daylight saving changes included.
--
-- Online figures come from online_sessions, each session expanded into
-- the hourly checks that saw her online (started_at, +1h, … last_seen_at).

/* ===================== INDEXES ===================== */

create index if not exists models_first_seen_at_idx on public.models (first_seen_at);
create index if not exists stories_first_seen_at_idx on public.stories (first_seen_at);
create index if not exists stories_published_at_idx on public.stories (published_at);
create index if not exists names_first_seen_at_idx on public.names (first_seen_at);
create index if not exists avatars_first_seen_at_idx on public.avatars (first_seen_at);
create index if not exists online_sessions_last_seen_at_idx on public.online_sessions (last_seen_at);

/* ===================== HELPERS ===================== */

-- Refuses a range the page never asks for, so an anonymous caller can't
-- make the database count every microsecond of a decade.
create or replace function public.analysis_check_range(p_since timestamptz, p_bucket text)
returns void
language plpgsql
immutable
as $$
begin
  if p_bucket not in ('hour', 'day') then
    raise exception 'p_bucket must be hour or day';
  end if;
  if p_since is null then
    raise exception 'p_since is required';
  end if;
end;
$$;

-- Refuses any time zone but the site's two.
create or replace function public.analysis_check_tz(p_tz text)
returns void
language plpgsql
immutable
as $$
begin
  if p_tz is null or p_tz not in ('UTC', 'Africa/Cairo') then
    raise exception 'p_tz must be UTC or Africa/Cairo';
  end if;
end;
$$;

-- Every hourly check each session's model was seen online at, from p_since.
create or replace function public.analysis_sightings(p_since timestamptz)
returns table (model_id bigint, seen_at timestamptz)
language sql
stable
set search_path = public
as $$
  select s.model_id, t
  from online_sessions s,
    generate_series(s.started_at, s.last_seen_at, interval '1 hour') t
  where s.last_seen_at >= p_since and t >= p_since;
$$;

/* ===================== HEADLINE ===================== */

-- The archive as it is now: { models, stories, names, avatars, renamed,
-- new_avatar, sessions, active_last_hour, last_run, archive_started }.
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
    'sessions', (select count(*) from online_sessions),
    'active_last_hour', (select count(*) from models where last_online_at >= now() - interval '1 hour'),
    'last_run', (select max(last_seen_at) from models),
    'archive_started', (select min(first_seen_at) from models)
  );
$$;

/* ===================== OVER TIME ===================== */

-- Per bucket since p_since: what the archive found new (models, stories,
-- names, avatars — by when it first saw them), the stories published then
-- (by coomeet's publication time), and how many models were seen online.
-- Buckets are made in p_tz's local time (so a day there is always a day,
-- 23 or 25 hours at a clock change) and answered as the instant each begins.
drop function if exists public.analysis_timeline(timestamptz, text);

create or replace function public.analysis_timeline(
  p_since timestamptz,
  p_bucket text,
  p_tz text default 'UTC'
)
returns table (
  bucket timestamptz,
  models bigint,
  stories bigint,
  names bigint,
  avatars bigint,
  published bigint,
  online bigint
)
language plpgsql
stable
set search_path = public
as $$
declare
  step interval := ('1 ' || p_bucket)::interval;
  first_local timestamp;
begin
  perform analysis_check_range(p_since, p_bucket);
  perform analysis_check_tz(p_tz);
  if p_bucket = 'hour' and p_since < now() - interval '31 days' then
    raise exception 'hourly buckets go back 31 days at most';
  end if;
  first_local := date_trunc(p_bucket, p_since at time zone p_tz);

  return query
  with b as (
    select generate_series(first_local, date_trunc(p_bucket, now() at time zone p_tz), step) as k
  ),
  m as (select date_trunc(p_bucket, first_seen_at at time zone p_tz) k, count(*) n from models
        where first_seen_at >= first_local at time zone p_tz group by 1),
  s as (select date_trunc(p_bucket, first_seen_at at time zone p_tz) k, count(*) n from stories
        where first_seen_at >= first_local at time zone p_tz group by 1),
  nm as (select date_trunc(p_bucket, first_seen_at at time zone p_tz) k, count(*) n from names
         where first_seen_at >= first_local at time zone p_tz group by 1),
  a as (select date_trunc(p_bucket, first_seen_at at time zone p_tz) k, count(*) n from avatars
        where first_seen_at >= first_local at time zone p_tz group by 1),
  p as (select date_trunc(p_bucket, published_at at time zone p_tz) k, count(*) n from stories
        where published_at >= first_local at time zone p_tz and published_at <= now() group by 1),
  o as (select date_trunc(p_bucket, seen_at at time zone p_tz) k, count(distinct model_id) n
        from analysis_sightings(first_local at time zone p_tz) group by 1)
  select b.k at time zone p_tz,
    coalesce(m.n, 0), coalesce(s.n, 0), coalesce(nm.n, 0), coalesce(a.n, 0),
    coalesce(p.n, 0), coalesce(o.n, 0)
  from b
  left join m on m.k = b.k
  left join s on s.k = b.k
  left join nm on nm.k = b.k
  left join a on a.k = b.k
  left join p on p.k = b.k
  left join o on o.k = b.k
  order by b.k;
end;
$$;

/* ===================== WEEK × HOUR ===================== */

-- For each day of the week (1 = Monday … 7 = Sunday) and hour of the day,
-- in p_tz: the average number of models online at a check then, and how
-- many checks that average is over; and how many stories were published
-- then.
drop function if exists public.analysis_week_hours(timestamptz);

create or replace function public.analysis_week_hours(p_since timestamptz, p_tz text default 'UTC')
returns table (dow int, hour int, online_avg numeric, checks bigint, published bigint)
language plpgsql
stable
set search_path = public
as $$
begin
  perform analysis_check_range(p_since, 'hour');
  perform analysis_check_tz(p_tz);
  return query
  with cells as (
    select d::int as dow, h::int as hour from generate_series(1, 7) d, generate_series(0, 23) h
  ),
  sightings as (
    select extract(isodow from seen_at at time zone p_tz)::int as dow,
      extract(hour from seen_at at time zone p_tz)::int as hour,
      count(*) n, count(distinct date_trunc('hour', seen_at)) checks
    from analysis_sightings(p_since) group by 1, 2
  ),
  pub as (
    select extract(isodow from published_at at time zone p_tz)::int as dow,
      extract(hour from published_at at time zone p_tz)::int as hour,
      count(*) n
    from stories where published_at >= p_since and published_at <= now() group by 1, 2
  )
  select c.dow, c.hour,
    case when s.checks > 0 then round(s.n::numeric / s.checks, 1) else 0 end,
    coalesce(s.checks, 0),
    coalesce(pub.n, 0)
  from cells c
  left join sightings s on s.dow = c.dow and s.hour = c.hour
  left join pub on pub.dow = c.dow and pub.hour = c.hour
  order by c.dow, c.hour;
end;
$$;

/* ===================== MODELS ===================== */

-- How many models' accounts were created each year (account_created_at is
-- the id itself) in p_tz, all time.
drop function if exists public.analysis_account_years();

create or replace function public.analysis_account_years(p_tz text default 'UTC')
returns table (year int, models bigint)
language plpgsql
stable
set search_path = public
as $$
begin
  perform analysis_check_tz(p_tz);
  return query
  select extract(year from account_created_at at time zone p_tz)::int, count(*)
  from models group by 1 order by 1;
end;
$$;

-- The top p_limit (at most 25) models by each measure:
--   online   checks that saw her online since p_since
--   stories  stories she published since p_since
--   names    names she's had, all time (more than one)
--   avatars  avatars she's had, all time (more than one)
-- Each as [{ id, name, avatar, value }].
create or replace function public.analysis_top(p_since timestamptz, p_limit int default 10)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  n int := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  perform analysis_check_range(p_since, 'hour');
  return jsonb_build_object(
    'online', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from analysis_sightings(p_since)
              group by 1 order by 2 desc, 1 limit n) x
        join models m on m.id = x.model_id
      ) t
    ),
    'stories', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.value desc, t.id), '[]')
      from (
        select m.id, m.current_name name, m.current_avatar avatar, x.value
        from (select model_id, count(*) value from stories
              where published_at >= p_since group by 1 order by 2 desc, 1 limit n) x
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
grant execute on function public.analysis_timeline(timestamptz, text, text) to anon, authenticated;
grant execute on function public.analysis_week_hours(timestamptz, text) to anon, authenticated;
grant execute on function public.analysis_account_years(text) to anon, authenticated;
grant execute on function public.analysis_top(timestamptz, int) to anon, authenticated;
