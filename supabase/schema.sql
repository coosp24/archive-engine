-- The archive's tables. Run once in the Supabase SQL editor.
--
-- models holds each model as she is now; names, avatars and stories collect
-- every value she has ever been seen with — the current one included, each
-- once — so a model's page can list them all from those tables alone.
-- online_sessions holds when she's been seen online (see online.sql).
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through record_story() below.

/* ===================== TABLES ===================== */

create table public.models (
  -- coomeet's id: the account's creation time in tenths of a millisecond.
  id bigint primary key,
  -- …so the creation date is the id itself (cooscrap-admin's
  -- createdAtFromId: epoch ms = id / 10).
  account_created_at timestamptz
    generated always as (to_timestamp(id / 10000.0)) stored,
  current_name text,
  current_avatar text,
  -- Her newest story, copied from stories so the general page needs no join.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- The last time a run saw her online.
  last_online_at timestamptz
);

-- Every name she has had, each once.
create table public.names (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every profile picture she has had, each once.
create table public.avatars (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, avatar)
);

-- Every story she has posted.
create table public.stories (
  -- coomeet's own id for the story.
  id bigint primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  -- The video's address on coomeet's CDN.
  story text not null unique,
  -- Its still image, on the same CDN.
  preview text,
  published_at timestamptz,
  first_seen_at timestamptz not null default now()
);

alter table public.models
  add foreign key (current_story_id) references public.stories (id)
  on delete set null;

create index stories_model_id_published_at_idx
  on public.stories (model_id, published_at desc);

-- Each stretch of runs that saw her online in a row: online from started_at
-- to last_seen_at, at an hour's resolution.
create table public.online_sessions (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index online_sessions_model_id_started_at_idx
  on public.online_sessions (model_id, started_at desc);
create index models_last_online_at_idx
  on public.models (last_online_at desc nulls last);

/* ===================== ACCESS ===================== */

alter table public.models enable row level security;
alter table public.names enable row level security;
alter table public.avatars enable row level security;
alter table public.stories enable row level security;
alter table public.online_sessions enable row level security;

create policy "Anyone can read models" on public.models
  for select to anon, authenticated using (true);
create policy "Anyone can read names" on public.names
  for select to anon, authenticated using (true);
create policy "Anyone can read avatars" on public.avatars
  for select to anon, authenticated using (true);
create policy "Anyone can read stories" on public.stories
  for select to anon, authenticated using (true);
create policy "Anyone can read online sessions" on public.online_sessions
  for select to anon, authenticated using (true);

/* ===================== WRITING ===================== */

-- Marks a model as seen by this run, online or not (null: the run couldn't
-- tell). Seen online when her last sighting was online too — last_online_at
-- is last_seen_at — the same session goes on; otherwise a new one starts.
-- That last sighting also has to be recent (90 minutes: an hourly run, give
-- or take a late start), so a run that never happened doesn't join two
-- sessions into one.
create or replace function public.mark_seen(
  p_model_id bigint,
  p_online boolean
) returns void
language plpgsql
set search_path = public
as $$
declare
  was_seen timestamptz;
  was_online timestamptz;
begin
  select last_seen_at, last_online_at into was_seen, was_online
  from models where id = p_model_id
  for update;
  if not found then
    return;
  end if;

  if p_online then
    if was_online = was_seen and was_seen > now() - interval '90 minutes' then
      update online_sessions set last_seen_at = now()
      where id = (
        select id from online_sessions
        where model_id = p_model_id
        order by started_at desc
        limit 1
      );
    else
      insert into online_sessions (model_id) values (p_model_id);
    end if;
  end if;

  update models set
    last_seen_at = now(),
    last_online_at = case when p_online then now() else last_online_at end
  where id = p_model_id;
end;
$$;

-- Records one story as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen, online or not, her name, avatar and
-- story added to their collections if they're new there, and her current_*
-- brought up to date. A story only becomes her current one if it's at least
-- as new as the one there — the feed isn't in date order.
--
-- Answers which of them were new: { model, name, avatar, story }.
create or replace function public.record_story(
  p_model_id bigint,
  p_name text,
  p_avatar text,
  p_story_id bigint,
  p_story text,
  p_preview text,
  p_published_at timestamptz,
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
begin
  insert into models (id) values (p_model_id)
  on conflict (id) do nothing;
  new_model := found;
  perform mark_seen(p_model_id, p_online);

  -- FOUND is false when on conflict do nothing skipped the row.
  if p_name is not null then
    insert into names (model_id, name) values (p_model_id, p_name)
    on conflict do nothing;
    new_name := found;
  end if;

  if p_avatar is not null then
    insert into avatars (model_id, avatar) values (p_model_id, p_avatar)
    on conflict do nothing;
    new_avatar := found;
  end if;

  insert into stories (id, model_id, story, preview, published_at)
  values (p_story_id, p_model_id, p_story, p_preview, p_published_at)
  on conflict do nothing;
  new_story := found;

  update models set
    current_name = coalesce(p_name, current_name),
    current_avatar = coalesce(p_avatar, current_avatar)
  where id = p_model_id;

  update models set
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
    'story', new_story
  );
end;
$$;

-- Saves many stories in one round trip (see supabase/record-stories.sql),
-- and marks as seen again the models the engine skipped because nothing
-- about them had changed: p_seen, of which p_seen_online were online. When
-- p_seen_online is null, no status is recorded for them.
create or replace function public.record_stories(
  p_stories jsonb,
  p_seen bigint[] default '{}',
  p_seen_online bigint[] default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  result jsonb;
  totals jsonb := jsonb_build_object('model', 0, 'name', 0, 'avatar', 0, 'story', 0);
  kind text;
  seen_id bigint;
begin
  for item in select * from jsonb_array_elements(coalesce(p_stories, '[]'::jsonb)) loop
    result := record_story(
      (item->>'model_id')::bigint,
      item->>'name',
      item->>'avatar',
      (item->>'story_id')::bigint,
      item->>'story',
      item->>'preview',
      (item->>'published_at')::timestamptz,
      (item->>'online')::boolean
    );
    foreach kind in array array['model', 'name', 'avatar', 'story'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;

  foreach seen_id in array coalesce(p_seen, '{}') loop
    perform mark_seen(
      seen_id,
      case when p_seen_online is null then null else seen_id = any(p_seen_online) end
    );
  end loop;

  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.mark_seen(bigint, boolean)
  from public, anon, authenticated;
revoke execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, boolean)
  from public, anon, authenticated;
revoke execute on function public.record_stories(jsonb, bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.mark_seen(bigint, boolean) to service_role;
grant execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, boolean)
  to service_role;
grant execute on function public.record_stories(jsonb, bigint[], bigint[])
  to service_role;
