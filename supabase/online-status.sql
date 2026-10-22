-- Online status, again — kept on her row only: models.last_online_at, the
-- last time a run saw her online, and cleared as soon as one sees her
-- offline (so she stops counting as active then, not an hour later). No
-- table of sessions. The site calls her active while it's within the last
-- hour. Run once in the Supabase SQL editor (schema.sql has the same end
-- state for a fresh setup). Safe to re-run, and safe before the engine that
-- sends the status is deployed: the old calls still work, and record none.

begin;

alter table public.models add column if not exists last_online_at timestamptz;

create index if not exists models_last_online_at_idx
  on public.models (last_online_at desc nulls last);

-- The versions without online status: each gains a parameter below.
drop function if exists public.mark_seen(bigint);
drop function if exists
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint);
drop function if exists public.record_stories(jsonb, bigint[]);

-- Marks a model as seen by this run, and online (now) or offline (no
-- longer: cleared at once, not left to run out its hour) when the run could
-- tell — p_online null leaves it as it was.
create or replace function public.mark_seen(p_model_id bigint, p_online boolean default null)
returns void
language sql
set search_path = public
as $$
  update models set
    last_seen_at = now(),
    last_online_at = case p_online when true then now() when false then null else last_online_at end
  where id = p_model_id;
$$;

-- Records one story as the engine saw it, in one round trip: her model row
-- (created on first sight) marked seen — online or offline, if p_online
-- says (see mark_seen) — her name, avatar and story added to
-- their collections if they're new there, her balance and (if it's a new
-- high) her peak balance kept, and her current_* brought up to date. A
-- story only becomes her current one if it's at least as new as the one
-- there — the feed isn't in date order. A story already saved gets its mp4
-- and gif if it has none (it was saved before they were kept); they're
-- never replaced.
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
    update models set
      current_balance = p_balance,
      peak_balance = greatest(peak_balance, p_balance)
    where id = p_model_id
      and current_balance is distinct from p_balance;
    new_balance := found;
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
-- the engine skipped because nothing about them had changed (p_seen): those
-- in p_seen_online as online, those in p_seen_offline as offline, the rest
-- as they were. p_stories: [{ model_id, name, avatar, story_id, story,
-- preview, published_at, mp4, gif, balance, online }].
create or replace function public.record_stories(
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
      (item->>'balance')::smallint,
      (item->>'online')::boolean
    );
    foreach kind in array array['model', 'name', 'avatar', 'story', 'balance'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;

  update models set
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
revoke execute on function public.mark_seen(bigint, boolean)
  from public, anon, authenticated;
revoke execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint, boolean)
  from public, anon, authenticated;
revoke execute on function public.record_stories(jsonb, bigint[], bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.mark_seen(bigint, boolean) to service_role;
grant execute on function
  public.record_story(bigint, text, text, bigint, text, text, timestamptz, text, text, smallint, boolean)
  to service_role;
grant execute on function public.record_stories(jsonb, bigint[], bigint[], bigint[]) to service_role;

commit;
