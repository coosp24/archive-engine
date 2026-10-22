-- coomeet's tables, and the functions the engine saves its runs through.
-- Run in the Supabase SQL editor, after supabase/shared/ (see
-- supabase/README.md). Safe to re-run.
--
-- coomeet_models holds each model as she is now; coomeet_names,
-- coomeet_avatars and coomeet_stories collect every value she has ever been
-- seen with — the current one included, each once — so a model's page can
-- list them all from those tables alone.
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through coomeet_record_stories() below.

/* ===================== TABLES ===================== */

create table if not exists public.coomeet_models (
  -- coomeet's id: the account's creation time in tenths of a millisecond.
  id bigint primary key,
  -- …so the creation date is the id itself (epoch ms = id / 10).
  account_created_at timestamptz
    generated always as (to_timestamp(id / 10000.0)) stored,
  current_name text,
  current_avatar text,
  -- Her newest story, copied from coomeet_stories so the models list needs
  -- no join.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- The minutes a viewer needs to add her as a friend, as coomeet last
  -- sent it: high while she's popular, falling as that fades.
  current_balance smallint,
  -- The highest balance she's been seen with: how popular she's ever been.
  -- Premium, on the site, once it's above 10 (coomeet's floor).
  peak_balance smallint,
  -- When a run last saw her online — cleared as soon as one sees her
  -- offline. The site calls her active while it's within the last hour.
  last_online_at timestamptz
);

-- Every name she has had, each once.
create table if not exists public.coomeet_names (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.coomeet_models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every profile picture she has had, each once.
create table if not exists public.coomeet_avatars (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.coomeet_models (id) on delete cascade,
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, avatar)
);

-- Every story she has posted.
create table if not exists public.coomeet_stories (
  -- coomeet's own id for the story.
  id bigint primary key,
  model_id bigint not null references public.coomeet_models (id) on delete cascade,
  -- The video's address on coomeet's CDN.
  story text not null unique,
  -- Its still image, on the same CDN.
  preview text,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  -- The video as MP4, and a small animated WebP of it (coomeet calls it
  -- gif): CDN addresses of their own, not the webm's with another extension.
  mp4 text,
  gif text
);

-- Named, because the engine and the site read a model's current story
-- through it (coomeet_stories also points back at coomeet_models).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coomeet_models_current_story_id_fkey'
  ) then
    alter table public.coomeet_models
      add constraint coomeet_models_current_story_id_fkey
      foreign key (current_story_id) references public.coomeet_stories (id) on delete set null;
  end if;
end;
$$;

create index if not exists coomeet_stories_model_id_published_at_idx
  on public.coomeet_stories (model_id, published_at desc);
-- For the site's "Recently active" filter, and its Premium list (highest
-- peak first).
create index if not exists coomeet_models_last_online_at_idx
  on public.coomeet_models (last_online_at desc nulls last);
create index if not exists coomeet_models_peak_balance_idx
  on public.coomeet_models (peak_balance desc nulls last);

/* ===================== ACCESS ===================== */

alter table public.coomeet_models enable row level security;
alter table public.coomeet_names enable row level security;
alter table public.coomeet_avatars enable row level security;
alter table public.coomeet_stories enable row level security;

drop policy if exists "Anyone can read models" on public.coomeet_models;
create policy "Anyone can read models" on public.coomeet_models
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read names" on public.coomeet_names;
create policy "Anyone can read names" on public.coomeet_names
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read avatars" on public.coomeet_avatars;
create policy "Anyone can read avatars" on public.coomeet_avatars
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read stories" on public.coomeet_stories;
create policy "Anyone can read stories" on public.coomeet_stories
  for select to anon, authenticated using (true);

/* ===================== WRITING ===================== */

-- Marks a model as seen by this run, and online (now) or offline (no
-- longer: cleared at once, not left to run out its hour) when the run could
-- tell — p_online null leaves it as it was.
create or replace function public.coomeet_mark_seen(p_model_id bigint, p_online boolean default null)
returns void
language sql
set search_path = public
as $$
  update coomeet_models set
    last_seen_at = now(),
    last_online_at = case p_online when true then now() when false then null else last_online_at end
  where id = p_model_id;
$$;

-- Records one story as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen — online or offline, if p_online
-- says (see coomeet_mark_seen) — her name, avatar and story added to their
-- collections if they're new there, her balance and (if it's a new high)
-- her peak balance kept, and her current_* brought up to date. A story
-- only becomes her current one if it's at least as new as the one there —
-- the feed isn't in date order. A story already saved gets its mp4 and gif
-- if it has none (it was saved before they were kept); they're never
-- replaced.
--
-- Answers which of them were new: { model, name, avatar, story, balance }.
create or replace function public.coomeet_record_story(
  p_model_id bigint,
  p_name text,
  p_avatar text,
  p_story_id bigint,
  p_story text,
  p_preview text,
  p_published_at timestamptz,
  p_mp4 text default null,
  p_gif text default null,
  p_balance smallint default null,
  p_online boolean default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  new_model boolean;
  new_name boolean := false;
  new_avatar boolean := false;
  new_story boolean;
  new_balance boolean := false;
begin
  insert into coomeet_models (id) values (p_model_id)
  on conflict (id) do nothing;
  new_model := found;
  perform coomeet_mark_seen(p_model_id, p_online);

  -- FOUND is false when on conflict do nothing skipped the row.
  if p_name is not null then
    insert into coomeet_names (model_id, name) values (p_model_id, p_name)
    on conflict do nothing;
    new_name := found;
  end if;

  if p_avatar is not null then
    insert into coomeet_avatars (model_id, avatar) values (p_model_id, p_avatar)
    on conflict do nothing;
    new_avatar := found;
  end if;

  insert into coomeet_stories (id, model_id, story, preview, published_at, mp4, gif)
  values (p_story_id, p_model_id, p_story, p_preview, p_published_at, p_mp4, p_gif)
  on conflict do nothing;
  new_story := found;

  if not new_story and (p_mp4 is not null or p_gif is not null) then
    update coomeet_stories set
      mp4 = coalesce(mp4, p_mp4),
      gif = coalesce(gif, p_gif)
    where id = p_story_id
      and (mp4 is null or gif is null);
  end if;

  if p_balance is not null then
    update coomeet_models set
      current_balance = p_balance,
      peak_balance = greatest(peak_balance, p_balance)
    where id = p_model_id
      and current_balance is distinct from p_balance;
    new_balance := found;
  end if;

  update coomeet_models set
    current_name = coalesce(p_name, current_name),
    current_avatar = coalesce(p_avatar, current_avatar)
  where id = p_model_id;

  update coomeet_models set
    current_story_id = p_story_id,
    current_story = p_story,
    current_story_preview = p_preview,
    current_story_published_at = p_published_at
  where id = p_model_id
    and (
      current_story_id is null
      or current_story_published_at is null
      or p_published_at >= current_story_published_at
    );

  return jsonb_build_object(
    'model', new_model,
    'name', new_name,
    'avatar', new_avatar,
    'story', new_story,
    'balance', new_balance
  );
end;
$$;

-- Saves many stories in one round trip, and marks as seen again the models
-- the engine skipped because nothing about them had changed (p_seen): those
-- in p_seen_online as online, those in p_seen_offline as offline, the rest
-- as they were. p_stories: [{ model_id, name, avatar, story_id, story,
-- preview, published_at, mp4, gif, balance, online }].
create or replace function public.coomeet_record_stories(
  p_stories jsonb,
  p_seen bigint[] default '{}',
  p_seen_online bigint[] default '{}',
  p_seen_offline bigint[] default '{}'
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  result jsonb;
  totals jsonb := jsonb_build_object('model', 0, 'name', 0, 'avatar', 0, 'story', 0, 'balance', 0);
  kind text;
begin
  for item in select * from jsonb_array_elements(coalesce(p_stories, '[]'::jsonb)) loop
    result := coomeet_record_story(
      (item->>'model_id')::bigint,
      item->>'name',
      item->>'avatar',
      (item->>'story_id')::bigint,
      item->>'story',
      item->>'preview',
      (item->>'published_at')::timestamptz,
      item->>'mp4',
      item->>'gif',
      (item->>'balance')::smallint,
      (item->>'online')::boolean
    );
    foreach kind in array array['model', 'name', 'avatar', 'story', 'balance'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;

  update coomeet_models set
    last_seen_at = now(),
    last_online_at = case
      when id = any(coalesce(p_seen_online, '{}')) then now()
      when id = any(coalesce(p_seen_offline, '{}')) then null
      else last_online_at
    end
  where id = any(coalesce(p_seen, '{}'));

  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.coomeet_mark_seen(bigint, boolean)
  from public, anon, authenticated;
revoke execute on function
  public.coomeet_record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint, boolean)
  from public, anon, authenticated;
revoke execute on function public.coomeet_record_stories(jsonb, bigint[], bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.coomeet_mark_seen(bigint, boolean) to service_role;
grant execute on function
  public.coomeet_record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint, boolean)
  to service_role;
grant execute on function public.coomeet_record_stories(jsonb, bigint[], bigint[], bigint[])
  to service_role;
