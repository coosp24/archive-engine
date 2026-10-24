-- flirtify's tables, and the function the engine saves its runs through.
-- Run in the Supabase SQL editor, after supabase/shared/ (see
-- supabase/README.md). Safe to re-run.
--
-- flirtify_models holds each model as she is now; flirtify_names,
-- flirtify_avatars and flirtify_stories collect every value she has ever
-- been seen with — the current one included, each once.
--
-- flirtify's picture and video links are signed, and stop working about two
-- days after it gives them out. So an avatar is told apart by its link
-- without the signature (avatar_key), and a story by its id; their links
-- (avatar, story, preview, current_*) are the last ones the engine was
-- given, saved again every run that sees them. last_seen_at says when: a
-- link last seen more than two days ago no longer works.
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through flirtify_record_models() below.

/* ===================== TABLES ===================== */

create table if not exists public.flirtify_models (
  -- flirtify's id: a 24-hex database id whose first 8 hex digits are the
  -- account's creation time, in Unix seconds…
  id text primary key check (id ~ '^[0-9a-f]{24}$'),
  -- …so the creation date is the id itself.
  account_created_at timestamptz
    generated always as (to_timestamp(('x' || substr(id, 1, 8))::bit(32)::bigint)) stored,
  -- Her other ids: a number, and her username — her profile is
  -- https://flirtify.com/profile/<username>.
  int_id bigint,
  username text,
  -- Her name as flirtify shows it (its "displayName").
  current_name text,
  current_avatar text,
  -- Her newest story still on flirtify, copied from flirtify_stories so a
  -- models list needs no join.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  -- A two-letter country code, from flirtify's category pages (her profile
  -- hides it).
  country text,
  -- Her age bracket, from flirtify's category pages: 18 (18–19), 20, 30
  -- and 40 (each decade), or 50 (50 and over).
  age_group smallint,
  -- Her profile's description, and the languages she speaks (two-letter
  -- codes), as she gives them.
  about text,
  languages text[],
  -- As flirtify gives them on her profile: its "callPriceInSec" (90 or 120
  -- so far, null for some) — the site's Premium models are those at 120 —
  -- and whether she takes calls ("available") or not ("private").
  call_price_in_sec smallint,
  access text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- When a run last saw her online or streaming — cleared as soon as one
  -- sees her offline; the site calls her active while it's within the last
  -- hour (as for coomeet).
  last_online_at timestamptz
);

-- Every name she has had, each once.
create table if not exists public.flirtify_names (
  id bigint generated always as identity primary key,
  model_id text not null references public.flirtify_models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every avatar she has had, each once (by avatar_key).
create table if not exists public.flirtify_avatars (
  id bigint generated always as identity primary key,
  model_id text not null references public.flirtify_models (id) on delete cascade,
  -- Its link without the signature: the same for the same picture.
  avatar_key text not null,
  -- Its link as last given out (see above).
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (model_id, avatar_key)
);

-- Every story she has posted.
create table if not exists public.flirtify_stories (
  -- flirtify's number for the story ("intId"), given out in order.
  id bigint primary key,
  -- Its other ids: a 24-hex one, and the slug of its page,
  -- https://flirtify.com/shorts/<slug>.
  uid text not null unique,
  slug text,
  model_id text not null references public.flirtify_models (id) on delete cascade,
  -- The video (MP4, 1080p) and its still image, as last given out (see
  -- above).
  story text not null,
  preview text,
  published_at timestamptz,
  -- 'vertical' or 'horizontal'.
  orientation text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Named, because the site reads a model's current story through it
-- (flirtify_stories also points back at flirtify_models).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flirtify_models_current_story_id_fkey'
  ) then
    alter table public.flirtify_models
      add constraint flirtify_models_current_story_id_fkey
      foreign key (current_story_id) references public.flirtify_stories (id) on delete set null;
  end if;
end;
$$;

create index if not exists flirtify_stories_model_id_published_at_idx
  on public.flirtify_stories (model_id, published_at desc);
-- For a "Recently active" filter.
create index if not exists flirtify_models_last_online_at_idx
  on public.flirtify_models (last_online_at desc nulls last);
-- For the site's models list: its default order (newest story) and "Recently
-- added" ones, each ending on the id as the list does, and when the engine
-- last saw anyone.
create index if not exists flirtify_models_current_story_published_at_idx
  on public.flirtify_models (current_story_published_at desc nulls last, id desc);
create index if not exists flirtify_models_first_seen_at_idx
  on public.flirtify_models (first_seen_at, id);
create index if not exists flirtify_models_last_seen_at_idx
  on public.flirtify_models (last_seen_at desc);
-- For the analysis page's days (flirtify_analysis_daily): what each table
-- gained when.
create index if not exists flirtify_names_first_seen_at_idx on public.flirtify_names (first_seen_at);
create index if not exists flirtify_avatars_first_seen_at_idx on public.flirtify_avatars (first_seen_at);
create index if not exists flirtify_stories_first_seen_at_idx on public.flirtify_stories (first_seen_at);
-- For the country filter.
create index if not exists flirtify_models_country_idx
  on public.flirtify_models (country);
-- For the Premium filter (the site's: a call price above 90).
create index if not exists flirtify_models_call_price_in_sec_idx
  on public.flirtify_models (call_price_in_sec desc);

/* ===================== ACCESS ===================== */

alter table public.flirtify_models enable row level security;
alter table public.flirtify_names enable row level security;
alter table public.flirtify_avatars enable row level security;
alter table public.flirtify_stories enable row level security;

drop policy if exists "Anyone can read models" on public.flirtify_models;
create policy "Anyone can read models" on public.flirtify_models
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read names" on public.flirtify_names;
create policy "Anyone can read names" on public.flirtify_names
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read avatars" on public.flirtify_avatars;
create policy "Anyone can read avatars" on public.flirtify_avatars
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read stories" on public.flirtify_stories;
create policy "Anyone can read stories" on public.flirtify_stories
  for select to anon, authenticated using (true);

/* ===================== READING ===================== */

-- The countries the models are from, with how many are from each, most
-- first: the site's country filter.
create or replace function public.flirtify_countries()
returns table (country text, models bigint)
language sql
stable
set search_path = public
as $$
  select country, count(*) from flirtify_models
  where country is not null
  group by country
  order by count(*) desc, country;
$$;

grant execute on function public.flirtify_countries() to anon, authenticated;

/* ===================== WRITING ===================== */

-- Records one model as the engine saw her, with her stories, in one round
-- trip: her row (created on first sight) marked seen — online (now) or
-- offline (cleared at once) — with what flirtify says of her brought up to
-- date; her name added to her names, and her avatar to her avatars, if
-- they're new there (an avatar seen before gets its fresh link); each story
-- added, or given its fresh links; and her current_* moved to her newest
-- story seen this time.
--
-- Answers how many of each were new: { model, name, avatar, story }.
create or replace function public.flirtify_record_model(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_model_id text := p->>'model_id';
  v_online boolean := (p->>'online')::boolean;
  new_model boolean;
  new_name boolean := false;
  new_avatar boolean := false;
  new_stories int := 0;
begin
  insert into flirtify_models (id) values (v_model_id)
  on conflict (id) do nothing;
  new_model := found;

  update flirtify_models m set
    last_seen_at = now(),
    last_online_at = case v_online when true then now() when false then null else m.last_online_at end,
    int_id = coalesce((p->>'int_id')::bigint, m.int_id),
    username = coalesce(p->>'username', m.username),
    current_name = coalesce(p->>'name', m.current_name),
    current_avatar = coalesce(p->>'avatar', m.current_avatar),
    country = coalesce(p->>'country', m.country),
    age_group = coalesce((p->>'age_group')::smallint, m.age_group),
    about = coalesce(p->>'about', m.about),
    languages = coalesce(
      (select array_agg(l) from jsonb_array_elements_text(p->'languages') l),
      m.languages
    ),
    call_price_in_sec = coalesce((p->>'call_price_in_sec')::smallint, m.call_price_in_sec),
    access = coalesce(p->>'access', m.access)
  where m.id = v_model_id;

  -- FOUND is false when on conflict do nothing skipped the row.
  if p->>'name' is not null then
    insert into flirtify_names (model_id, name) values (v_model_id, p->>'name')
    on conflict do nothing;
    new_name := found;
  end if;

  -- xmax is 0 for a row the statement inserted, not one it updated.
  if p->>'avatar_key' is not null and p->>'avatar' is not null then
    insert into flirtify_avatars as a (model_id, avatar_key, avatar)
    values (v_model_id, p->>'avatar_key', p->>'avatar')
    on conflict (model_id, avatar_key) do update set
      avatar = excluded.avatar,
      last_seen_at = now()
    returning (a.xmax = 0) into new_avatar;
  end if;

  with input as (
    select *
    from jsonb_to_recordset(coalesce(p->'stories', '[]'::jsonb))
      as x(story_id bigint, uid text, slug text, story text, preview text,
           published_at timestamptz, orientation text)
    where x.story_id is not null and x.uid is not null and x.story is not null
  ),
  saved as (
    insert into flirtify_stories as s (id, uid, slug, model_id, story, preview, published_at, orientation)
    select story_id, uid, slug, v_model_id, story, preview, published_at, orientation from input
    on conflict (id) do update set
      story = excluded.story,
      preview = coalesce(excluded.preview, s.preview),
      slug = coalesce(excluded.slug, s.slug),
      published_at = coalesce(excluded.published_at, s.published_at),
      orientation = coalesce(excluded.orientation, s.orientation),
      last_seen_at = now()
    returning (s.xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into new_stories from saved;

  -- Her newest story among those seen just now (their last_seen_at is this
  -- transaction's now()): one she has deleted has a dead link.
  update flirtify_models m set
    current_story_id = s.id,
    current_story = s.story,
    current_story_preview = s.preview,
    current_story_published_at = s.published_at
  from (
    select id, story, preview, published_at from flirtify_stories
    where model_id = v_model_id and last_seen_at = now()
    order by published_at desc nulls last, id desc
    limit 1
  ) s
  where m.id = v_model_id;

  return jsonb_build_object(
    'model', new_model::int,
    'name', new_name::int,
    'avatar', coalesce(new_avatar, false)::int,
    'story', new_stories
  );
end;
$$;

-- Saves many models in one round trip, each through
-- flirtify_record_model(). p_models: [{ model_id, int_id, username, name,
-- avatar, avatar_key, online, country, age_group, about, languages,
-- call_price_in_sec, access, stories: [{ story_id, uid, slug, story,
-- preview, published_at, orientation }] }]. Answers how many of each were
-- new: { model, name, avatar, story }.
create or replace function public.flirtify_record_models(p_models jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  result jsonb;
  totals jsonb := jsonb_build_object('model', 0, 'name', 0, 'avatar', 0, 'story', 0);
  kind text;
begin
  for item in select * from jsonb_array_elements(coalesce(p_models, '[]'::jsonb)) loop
    result := flirtify_record_model(item);
    foreach kind in array array['model', 'name', 'avatar', 'story'] loop
      totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + (result->>kind)::int));
    end loop;
  end loop;
  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.flirtify_record_model(jsonb) from public, anon, authenticated;
revoke execute on function public.flirtify_record_models(jsonb) from public, anon, authenticated;
grant execute on function public.flirtify_record_model(jsonb) to service_role;
grant execute on function public.flirtify_record_models(jsonb) to service_role;
