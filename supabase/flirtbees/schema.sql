-- flirtbees' tables, and the function the engine saves its runs through.
-- Run in the Supabase SQL editor, after supabase/shared/ (see
-- supabase/README.md). Safe to re-run.
--
-- flirtbees_models holds each model as she is now; flirtbees_names,
-- flirtbees_avatars and flirtbees_stories collect every value she has ever
-- been seen with — the current one included, each once.
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through flirtbees_record_stories() below.

/* ===================== TABLES ===================== */

create table if not exists public.flirtbees_models (
  -- flirtbees' id: a 24-hex database id whose first 8 hex digits are the
  -- account's creation time, in Unix seconds…
  id text primary key check (id ~ '^[0-9a-f]{24}$'),
  -- …so the creation date is the id itself.
  account_created_at timestamptz
    generated always as (to_timestamp(('x' || substr(id, 1, 8))::bit(32)::bigint)) stored,
  -- Her other id, which flirtbees' API asks for her stories by.
  uid text not null unique,
  current_name text,
  -- Her full-size avatar (flirtbees sends a small one; the engine keeps the
  -- full one beside it).
  current_avatar text,
  -- Her newest story, copied from flirtbees_stories so a models list needs
  -- no join.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- When a run last saw her online — cleared as soon as one sees her
  -- offline; the site calls her active while it's within the last hour (as
  -- for coomeet).
  last_online_at timestamptz,
  -- When flirtbees says she was last online, as it last said it. Kept, but
  -- not what "active" is worked out from.
  site_last_online_at timestamptz
);

-- Added after the table was first made: how much her stories are liked —
-- for the site's Premium models (as coomeet's): the likes and points of all
-- her stories, added up (flirtbees gives nothing else to tell). Kept up to
-- date by flirtbees_record_story(); filled in here for those saved before.
alter table public.flirtbees_models add column if not exists premium_score integer;
update public.flirtbees_models m set premium_score = coalesce((
  select sum(coalesce(s.likes, 0) + coalesce(s.points, 0)) from public.flirtbees_stories s where s.model_id = m.id
), 0)
where m.premium_score is null;

-- Every name she has had, each once.
create table if not exists public.flirtbees_names (
  id bigint generated always as identity primary key,
  model_id text not null references public.flirtbees_models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every (full-size) avatar she has had, each once.
create table if not exists public.flirtbees_avatars (
  id bigint generated always as identity primary key,
  model_id text not null references public.flirtbees_models (id) on delete cascade,
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, avatar)
);

-- Every story she has posted.
create table if not exists public.flirtbees_stories (
  -- flirtbees' own id for the story.
  id bigint primary key,
  -- Its other id: the story's link is https://flirtbees.com?s=<uid>.
  uid text not null unique,
  model_id text not null references public.flirtbees_models (id) on delete cascade,
  -- The video (webm), the same as MP4, and its still image.
  story text not null,
  mp4 text,
  preview text,
  published_at timestamptz,
  -- As flirtbees last counted them: brought up to date every run that sees
  -- the story.
  likes integer,
  points integer,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Named, because the site will read a model's current story through it
-- (flirtbees_stories also points back at flirtbees_models).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flirtbees_models_current_story_id_fkey'
  ) then
    alter table public.flirtbees_models
      add constraint flirtbees_models_current_story_id_fkey
      foreign key (current_story_id) references public.flirtbees_stories (id) on delete set null;
  end if;
end;
$$;

create index if not exists flirtbees_stories_model_id_published_at_idx
  on public.flirtbees_stories (model_id, published_at desc);
-- For a "Recently active" filter.
create index if not exists flirtbees_models_last_online_at_idx
  on public.flirtbees_models (last_online_at desc nulls last);
-- For the Premium filter.
create index if not exists flirtbees_models_premium_score_idx
  on public.flirtbees_models (premium_score desc nulls last);

/* ===================== ACCESS ===================== */

alter table public.flirtbees_models enable row level security;
alter table public.flirtbees_names enable row level security;
alter table public.flirtbees_avatars enable row level security;
alter table public.flirtbees_stories enable row level security;

drop policy if exists "Anyone can read models" on public.flirtbees_models;
create policy "Anyone can read models" on public.flirtbees_models
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read names" on public.flirtbees_names;
create policy "Anyone can read names" on public.flirtbees_names
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read avatars" on public.flirtbees_avatars;
create policy "Anyone can read avatars" on public.flirtbees_avatars
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read stories" on public.flirtbees_stories;
create policy "Anyone can read stories" on public.flirtbees_stories
  for select to anon, authenticated using (true);

/* ===================== WRITING ===================== */

-- Records one story as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen — online (now) or offline (cleared
-- at once), and flirtbees' own last-online time kept — her name and avatar
-- added to their collections if they're new there, the story added or, if
-- it's saved already, its likes and points brought up to date, and her
-- current_* brought up to date. A story only becomes her current one if
-- it's at least as new as the one there — the feed is shuffled. Her
-- premium_score is worked out again from all her stories.
--
-- Answers which of them were new: { model, name, avatar, story }.
create or replace function public.flirtbees_record_story(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_model_id text := p->>'model_id';
  v_story_id bigint := (p->>'story_id')::bigint;
  v_published timestamptz := (p->>'published_at')::timestamptz;
  v_online boolean := (p->>'online')::boolean;
  new_model boolean;
  new_name boolean := false;
  new_avatar boolean := false;
  new_story boolean;
begin
  insert into flirtbees_models (id, uid) values (v_model_id, p->>'model_uid')
  on conflict (id) do nothing;
  new_model := found;

  update flirtbees_models m set
    last_seen_at = now(),
    last_online_at = case v_online when true then now() when false then null else m.last_online_at end,
    site_last_online_at = coalesce((p->>'site_last_online_at')::timestamptz, m.site_last_online_at),
    current_name = coalesce(p->>'name', m.current_name),
    current_avatar = coalesce(p->>'avatar', m.current_avatar)
  where m.id = v_model_id;

  -- FOUND is false when on conflict do nothing skipped the row.
  if p->>'name' is not null then
    insert into flirtbees_names (model_id, name) values (v_model_id, p->>'name')
    on conflict do nothing;
    new_name := found;
  end if;

  if p->>'avatar' is not null then
    insert into flirtbees_avatars (model_id, avatar) values (v_model_id, p->>'avatar')
    on conflict do nothing;
    new_avatar := found;
  end if;

  insert into flirtbees_stories (id, uid, model_id, story, mp4, preview, published_at, likes, points)
  values (v_story_id, p->>'story_uid', v_model_id, p->>'story', p->>'mp4', p->>'preview', v_published,
          (p->>'likes')::int, (p->>'points')::int)
  on conflict do nothing;
  new_story := found;

  if not new_story then
    update flirtbees_stories s set
      likes = coalesce((p->>'likes')::int, s.likes),
      points = coalesce((p->>'points')::int, s.points),
      updated_at = now()
    where s.id = v_story_id;
  end if;

  update flirtbees_models set
    current_story_id = v_story_id,
    current_story = p->>'story',
    current_story_preview = p->>'preview',
    current_story_published_at = v_published
  where id = v_model_id
    and (
      current_story_id is null
      or current_story_published_at is null
      or v_published >= current_story_published_at
    );

  -- Her Premium score, with this story's likes and points as they are now.
  update flirtbees_models m set premium_score = (
    select coalesce(sum(coalesce(s.likes, 0) + coalesce(s.points, 0)), 0)
    from flirtbees_stories s where s.model_id = v_model_id
  )
  where m.id = v_model_id;

  return jsonb_build_object(
    'model', new_model,
    'name', new_name,
    'avatar', new_avatar,
    'story', new_story
  );
end;
$$;

-- Saves many stories in one round trip, each through
-- flirtbees_record_story(). p_stories: [{ model_id, model_uid, name,
-- avatar, online, site_last_online_at, story_id, story_uid, story, mp4,
-- preview, published_at, likes, points }]. Answers how many of each were
-- new: { model, name, avatar, story }.
create or replace function public.flirtbees_record_stories(p_stories jsonb)
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
    result := flirtbees_record_story(item);
    foreach kind in array array['model', 'name', 'avatar', 'story'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;
  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.flirtbees_record_story(jsonb) from public, anon, authenticated;
revoke execute on function public.flirtbees_record_stories(jsonb) from public, anon, authenticated;
grant execute on function public.flirtbees_record_story(jsonb) to service_role;
grant execute on function public.flirtbees_record_stories(jsonb) to service_role;
