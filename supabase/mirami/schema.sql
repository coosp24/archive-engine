-- mirami's tables, and the function the engine saves its runs through.
-- Run in the Supabase SQL editor, after supabase/shared/ (see
-- supabase/README.md). Safe to re-run.
--
-- mirami_models holds each model as she is now; mirami_names,
-- mirami_avatars and mirami_stories collect every value she has ever been
-- seen with — the current one included, each once. Her stories are
-- mirami's reels.
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through mirami_record_stories() below.

/* ===================== TABLES ===================== */

create table if not exists public.mirami_models (
  -- mirami's id for her: a number, given out in order.
  id bigint primary key,
  -- mirami doesn't say when an account was made. Kept so every site's
  -- models have the same columns; always null.
  account_created_at timestamptz,
  -- Her other id: her profile is https://mirami.chat/girl/<ref_code>.
  ref_code text,
  -- Her name as mirami shows it (its "nick").
  current_name text,
  -- The other name mirami sends for her, not shown (its "name"): often a
  -- full name. As mirami last sent it.
  profile_name text,
  current_avatar text,
  -- Her newest reel (the highest id), copied from mirami_stories so a
  -- models list needs no join. Reels carry no date, so its "published" time
  -- is when the archive first saw it.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  -- As she gives them on mirami: a two-letter country code, her birthday
  -- and age.
  country text,
  birthday date,
  age smallint,
  -- Whether mirami marks her verified, and her "about" line.
  verified boolean,
  about text,
  -- As mirami last counted them: brought up to date every run that sees
  -- her. shows_count only when she was in mirami's girls lists that run.
  likes_count integer,
  favourites_count integer,
  gifts_count integer,
  shows_count integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- When a run last saw her online — cleared as soon as one sees her
  -- offline; the site calls her active while it's within the last hour (as
  -- for coomeet).
  last_online_at timestamptz,
  -- When mirami says she last visited, as it last said it. Kept, but not
  -- what "active" is worked out from.
  site_last_visit_at timestamptz
);

-- Added after the table was first made.
alter table public.mirami_models add column if not exists profile_name text;
-- How much viewers give her, for the site's "Top" models (as coomeet's
-- Premium): a like is free, a favourite a commitment, a gift costs money —
-- so likes + 5 × favourites + 20 × gifts. Worked out by the database from
-- the counts, as they're brought up to date.
alter table public.mirami_models add column if not exists top_score integer
  generated always as (
    coalesce(likes_count, 0) + 5 * coalesce(favourites_count, 0) + 20 * coalesce(gifts_count, 0)
  ) stored;

-- Every name she has had, each once.
create table if not exists public.mirami_names (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.mirami_models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every avatar she has had, each once.
create table if not exists public.mirami_avatars (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.mirami_models (id) on delete cascade,
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, avatar)
);

-- Every reel she has posted.
create table if not exists public.mirami_stories (
  -- mirami's own id for the reel.
  id bigint primary key,
  model_id bigint not null references public.mirami_models (id) on delete cascade,
  -- The video (MP4) and its still image.
  story text not null,
  preview text,
  -- mirami doesn't say when a reel was posted: always null. The web orders
  -- reels by id instead, which mirami gives out in order.
  published_at timestamptz,
  -- As mirami last counted them: brought up to date every run that sees
  -- the reel.
  likes integer,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Named, because the site reads a model's current story through it
-- (mirami_stories also points back at mirami_models).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mirami_models_current_story_id_fkey'
  ) then
    alter table public.mirami_models
      add constraint mirami_models_current_story_id_fkey
      foreign key (current_story_id) references public.mirami_stories (id) on delete set null;
  end if;
end;
$$;

-- Every photo in her mirami gallery: her avatar and the others, as mirami
-- lists them on her profile. Not the same as mirami_avatars, the avatars
-- she's been seen with (which search by photo reads): these aren't
-- fingerprinted.
create table if not exists public.mirami_photos (
  -- mirami's own id for the photo.
  id bigint primary key,
  model_id bigint not null references public.mirami_models (id) on delete cascade,
  -- 'avatar' or 'gallery', as mirami says.
  kind text not null,
  -- Only for Premium members: mirami sends no picture of it, only a blurred
  -- one, so image and original are null.
  premium boolean not null default false,
  -- A 428×428 crop, and the photo itself (up to 1920×1080).
  image text,
  original text,
  -- When she posted it, as mirami says.
  posted_at timestamptz,
  -- As mirami last counted them: brought up to date every run that sees it.
  likes integer,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mirami_stories_model_id_id_idx
  on public.mirami_stories (model_id, id desc);
create index if not exists mirami_photos_model_id_posted_at_idx
  on public.mirami_photos (model_id, posted_at desc);
-- For a "Recently active" filter.
create index if not exists mirami_models_last_online_at_idx
  on public.mirami_models (last_online_at desc nulls last);
-- For the Top filter and her rank, and the country filter.
create index if not exists mirami_models_top_score_idx
  on public.mirami_models (top_score desc);
create index if not exists mirami_models_country_idx
  on public.mirami_models (country);

/* ===================== ACCESS ===================== */

alter table public.mirami_models enable row level security;
alter table public.mirami_names enable row level security;
alter table public.mirami_avatars enable row level security;
alter table public.mirami_stories enable row level security;
alter table public.mirami_photos enable row level security;

drop policy if exists "Anyone can read models" on public.mirami_models;
create policy "Anyone can read models" on public.mirami_models
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read names" on public.mirami_names;
create policy "Anyone can read names" on public.mirami_names
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read avatars" on public.mirami_avatars;
create policy "Anyone can read avatars" on public.mirami_avatars
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read stories" on public.mirami_stories;
create policy "Anyone can read stories" on public.mirami_stories
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read photos" on public.mirami_photos;
create policy "Anyone can read photos" on public.mirami_photos
  for select to anon, authenticated using (true);

/* ===================== READING ===================== */

-- The countries the models say they're from, with how many say each, most
-- first: the site's country filter.
create or replace function public.mirami_countries()
returns table (country text, models bigint)
language sql
stable
set search_path = public
as $$
  select country, count(*) from mirami_models
  where country is not null
  group by country
  order by count(*) desc, country;
$$;

grant execute on function public.mirami_countries() to anon, authenticated;

/* ===================== WRITING ===================== */

-- Records one reel as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen — online (now) or offline (cleared
-- at once) — with what mirami says of her brought up to date, her name and
-- avatar added to their collections if they're new there, the reel added
-- or, if it's saved already, its likes brought up to date, and her
-- current_* moved to it if it's her newest (highest id). Without a story_id
-- it records just her: a girl from mirami's lists, with no reel.
--
-- Answers which of them were new: { model, name, avatar, story }.
create or replace function public.mirami_record_story(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_model_id bigint := (p->>'model_id')::bigint;
  v_story_id bigint := (p->>'story_id')::bigint;
  v_online boolean := (p->>'online')::boolean;
  v_first_seen timestamptz;
  new_model boolean;
  new_name boolean := false;
  new_avatar boolean := false;
  new_story boolean;
begin
  insert into mirami_models (id) values (v_model_id)
  on conflict (id) do nothing;
  new_model := found;

  update mirami_models m set
    last_seen_at = now(),
    last_online_at = case v_online when true then now() when false then null else m.last_online_at end,
    site_last_visit_at = coalesce((p->>'site_last_visit_at')::timestamptz, m.site_last_visit_at),
    ref_code = coalesce(p->>'ref_code', m.ref_code),
    current_name = coalesce(p->>'name', m.current_name),
    profile_name = coalesce(p->>'profile_name', m.profile_name),
    current_avatar = coalesce(p->>'avatar', m.current_avatar),
    country = coalesce(p->>'country', m.country),
    birthday = coalesce((p->>'birthday')::date, m.birthday),
    age = coalesce((p->>'age')::smallint, m.age),
    verified = coalesce((p->>'verified')::boolean, m.verified),
    about = coalesce(p->>'about', m.about),
    likes_count = coalesce((p->>'likes_count')::int, m.likes_count),
    favourites_count = coalesce((p->>'favourites_count')::int, m.favourites_count),
    gifts_count = coalesce((p->>'gifts_count')::int, m.gifts_count),
    shows_count = coalesce((p->>'shows_count')::int, m.shows_count)
  where m.id = v_model_id;

  -- FOUND is false when on conflict do nothing skipped the row.
  if p->>'name' is not null then
    insert into mirami_names (model_id, name) values (v_model_id, p->>'name')
    on conflict do nothing;
    new_name := found;
  end if;

  if p->>'avatar' is not null then
    insert into mirami_avatars (model_id, avatar) values (v_model_id, p->>'avatar')
    on conflict do nothing;
    new_avatar := found;
  end if;

  if v_story_id is null then
    return jsonb_build_object('model', new_model, 'name', new_name, 'avatar', new_avatar, 'story', false);
  end if;

  insert into mirami_stories (id, model_id, story, preview, likes)
  values (v_story_id, v_model_id, p->>'story', p->>'preview', (p->>'likes')::int)
  on conflict do nothing;
  new_story := found;

  update mirami_stories s set
    likes = coalesce((p->>'likes')::int, s.likes),
    updated_at = now()
  where s.id = v_story_id and not new_story
  returning s.first_seen_at into v_first_seen;
  if new_story then v_first_seen := now(); end if;

  update mirami_models set
    current_story_id = v_story_id,
    current_story = p->>'story',
    current_story_preview = p->>'preview',
    current_story_published_at = v_first_seen
  where id = v_model_id
    and (current_story_id is null or v_story_id >= current_story_id);

  return jsonb_build_object(
    'model', new_model,
    'name', new_name,
    'avatar', new_avatar,
    'story', new_story
  );
end;
$$;

-- Saves many reels (and girls without one) in one round trip, each through
-- mirami_record_story().
-- p_stories: [{ model_id, ref_code, name, profile_name, avatar, online,
-- site_last_visit_at, country, birthday, age, verified, about, likes_count,
-- favourites_count, gifts_count, shows_count, story_id, story, preview,
-- likes }]. Answers how many of each were new: { model, name, avatar,
-- story }.
create or replace function public.mirami_record_stories(p_stories jsonb)
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
  for item in select * from jsonb_array_elements(coalesce(p_stories, '[]'::jsonb)) loop
    result := mirami_record_story(item);
    foreach kind in array array['model', 'name', 'avatar', 'story'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;
  return totals;
end;
$$;

-- Saves the photos in her galleries as a run saw them, in one round trip:
-- p_photos = [{ id, model_id, kind, premium, image, original, posted_at,
-- likes }]. A photo already saved is brought up to date (its likes, and
-- its pictures if it's no longer Premium only). A photo whose model isn't
-- saved (her reels failed to save) is left out. Answers { photo }: how many
-- were new.
create or replace function public.mirami_record_photos(p_photos jsonb)
returns jsonb
language sql
set search_path = public
as $$
  with input as (
    select *
    from jsonb_to_recordset(coalesce(p_photos, '[]'::jsonb))
      as x(id bigint, model_id bigint, kind text, premium boolean, image text, original text,
           posted_at timestamptz, likes int)
    where exists (select 1 from mirami_models m where m.id = x.model_id)
  ),
  saved as (
    insert into mirami_photos as p (id, model_id, kind, premium, image, original, posted_at, likes)
    select id, model_id, kind, coalesce(premium, false), image, original, posted_at, likes from input
    on conflict (id) do update set
      premium = excluded.premium,
      image = coalesce(excluded.image, p.image),
      original = coalesce(excluded.original, p.original),
      likes = coalesce(excluded.likes, p.likes),
      updated_at = now()
    -- xmax is 0 for a row this statement inserted, not one it updated.
    returning (xmax = 0) as inserted
  )
  select jsonb_build_object('photo', (select count(*) from saved where inserted));
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.mirami_record_story(jsonb) from public, anon, authenticated;
revoke execute on function public.mirami_record_stories(jsonb) from public, anon, authenticated;
revoke execute on function public.mirami_record_photos(jsonb) from public, anon, authenticated;
grant execute on function public.mirami_record_story(jsonb) to service_role;
grant execute on function public.mirami_record_stories(jsonb) to service_role;
grant execute on function public.mirami_record_photos(jsonb) to service_role;
