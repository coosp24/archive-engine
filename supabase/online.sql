-- Online status. Run once in the Supabase SQL editor (it's also part of
-- schema.sql for a fresh setup). Safe to re-run.
--
-- coomeet sends `online: 0 | 1` on every story in its feed — the same flag
-- its stories page draws the green dot beside her avatar from. Each run
-- (hourly) reads it for everyone with a story up:
--
--   models.last_online_at  the last time a run saw her online — the site
--                          calls her active if that's within the last hour
--   online_sessions        each stretch of runs that saw her online in a
--                          row: online from started_at to last_seen_at, at
--                          an hour's resolution
--
-- Safe to run before the engine that sends the status is deployed: the old
-- calls still work, and record no status.

/* ===================== TABLES ===================== */

alter table public.models
  add column if not exists last_online_at timestamptz;

-- From an earlier draft of this file, if it was run: online status is now
-- only last_online_at.
alter table public.models drop column if exists is_online;
drop function if exists public.finish_online_check(timestamptz);

create table if not exists public.online_sessions (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists online_sessions_model_id_started_at_idx
  on public.online_sessions (model_id, started_at desc);

-- For the site's "Recently active" filter (seen online in the last hour).
create index if not exists models_last_online_at_idx
  on public.models (last_online_at desc nulls last);

alter table public.online_sessions enable row level security;

drop policy if exists "Anyone can read online sessions" on public.online_sessions;
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

-- record_story() as before, plus her online status. The model row is no
-- longer touched on conflict: mark_seen() needs to read when she was last
-- seen before it moves that on.
drop function if exists
  public.record_story(bigint, text, text, bigint, text, text, timestamptz);

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

-- record_stories() as before, plus each story's `online`, and
-- p_seen_online: which of the p_seen models were online. When it's null
-- (an engine from before online status), p_seen only marks them seen.
drop function if exists public.record_stories(jsonb, bigint[]);

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
