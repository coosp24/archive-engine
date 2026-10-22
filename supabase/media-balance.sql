-- Story media and balance in; online status out. Run once in the Supabase
-- SQL editor (schema.sql has the same end state for a fresh setup). Safe to
-- re-run. Run it right before deploying the engine that goes with it: the
-- engine before it sends online status, which record_stories() no longer
-- takes, and the engine after it reads models.current_balance.
--
-- Added, from what coomeet's feed sends with each story:
--   stories.mp4, stories.gif  the video as MP4, and a small animated WebP of
--                             it (coomeet calls it gif) — each a CDN address
--                             of its own, not the webm's with another
--                             extension. Empty on stories saved before this.
--   models.current_balance    the minutes a viewer needs to add her as a
--                             friend: high while she's popular, falling as
--                             that fades. Its index is for a "best models"
--                             list, highest first.
--   balances                  every balance she's had, a row each time it
--                             changes (60, 46, 60 is three rows).
--
-- Removed: online status — online_sessions, models.last_online_at and
-- runs.online_models, with what used them. A model is still marked seen by
-- every run (models.last_seen_at).

begin;

/* ===================== ONLINE STATUS, REMOVED ===================== */

drop function if exists public.record_stories(jsonb, bigint[], bigint[]);
drop function if exists
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, boolean);
drop function if exists public.mark_seen(bigint, boolean);
-- From before online status, if they were never replaced.
drop function if exists public.record_story(bigint, text, text, bigint, text, text, timestamptz);
drop function if exists public.record_stories(jsonb, bigint[]);

drop table if exists public.online_sessions;
drop index if exists public.models_last_online_at_idx;
alter table public.models drop column if exists last_online_at;
alter table public.runs drop column if exists online_models;

-- analysis_totals() without active_last_hour, which read last_online_at
-- (analysis.sql has the same).
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

/* ===================== TABLES ===================== */

alter table public.stories add column if not exists mp4 text;
alter table public.stories add column if not exists gif text;

alter table public.models add column if not exists current_balance smallint;

create index if not exists models_current_balance_idx
  on public.models (current_balance desc nulls last);

create table if not exists public.balances (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  balance smallint not null,
  seen_at timestamptz not null default now()
);

create index if not exists balances_model_id_seen_at_idx
  on public.balances (model_id, seen_at desc);

alter table public.balances enable row level security;

drop policy if exists "Anyone can read balances" on public.balances;
create policy "Anyone can read balances" on public.balances
  for select to anon, authenticated using (true);

/* ===================== WRITING ===================== */

-- Marks a model as seen by this run.
create or replace function public.mark_seen(p_model_id bigint)
returns void
language sql
set search_path = public
as $$
  update models set last_seen_at = now() where id = p_model_id;
$$;

-- Records one story as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen, her name, avatar and story added to
-- their collections if they're new there, her balance added to its
-- timeline if it changed, and her current_* brought up to date. A story only
-- becomes her current one if it's at least as new as the one there — the
-- feed isn't in date order. A story already saved gets its mp4 and gif if
-- it has none (it was saved before they were kept); they're never replaced.
--
-- Answers which of them were new: { model, name, avatar, story, balance }.
create or replace function public.record_story(
  p_model_id bigint,
  p_name text,
  p_avatar text,
  p_story_id bigint,
  p_story text,
  p_preview text,
  p_published_at timestamptz,
  p_mp4 text default null,
  p_gif text default null,
  p_balance smallint default null
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
  insert into models (id) values (p_model_id)
  on conflict (id) do nothing;
  new_model := found;
  perform mark_seen(p_model_id);

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

  insert into stories (id, model_id, story, preview, published_at, mp4, gif)
  values (p_story_id, p_model_id, p_story, p_preview, p_published_at, p_mp4, p_gif)
  on conflict do nothing;
  new_story := found;

  if not new_story and (p_mp4 is not null or p_gif is not null) then
    update stories set
      mp4 = coalesce(mp4, p_mp4),
      gif = coalesce(gif, p_gif)
    where id = p_story_id
      and (mp4 is null or gif is null);
  end if;

  if p_balance is not null then
    update models set current_balance = p_balance
    where id = p_model_id
      and current_balance is distinct from p_balance;
    new_balance := found;
    if new_balance then
      insert into balances (model_id, balance) values (p_model_id, p_balance);
    end if;
  end if;

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
    'story', new_story,
    'balance', new_balance
  );
end;
$$;

-- Saves many stories in one round trip, and marks as seen again the models
-- the engine skipped because nothing about them had changed (p_seen).
-- p_stories: [{ model_id, name, avatar, story_id, story, preview,
-- published_at, mp4, gif, balance }].
create or replace function public.record_stories(
  p_stories jsonb,
  p_seen bigint[] default '{}'
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
    result := record_story(
      (item->>'model_id')::bigint,
      item->>'name',
      item->>'avatar',
      (item->>'story_id')::bigint,
      item->>'story',
      item->>'preview',
      (item->>'published_at')::timestamptz,
      item->>'mp4',
      item->>'gif',
      (item->>'balance')::smallint
    );
    foreach kind in array array['model', 'name', 'avatar', 'story', 'balance'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;

  update models set last_seen_at = now() where id = any(coalesce(p_seen, '{}'));

  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.mark_seen(bigint)
  from public, anon, authenticated;
revoke execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint)
  from public, anon, authenticated;
revoke execute on function public.record_stories(jsonb, bigint[])
  from public, anon, authenticated;
grant execute on function public.mark_seen(bigint) to service_role;
grant execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint)
  to service_role;
grant execute on function public.record_stories(jsonb, bigint[]) to service_role;

commit;
