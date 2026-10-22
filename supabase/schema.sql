-- The archive's tables. Run once in the Supabase SQL editor.
--
-- models holds each model as she is now; names, avatars and stories collect
-- every value she has ever been seen with — the current one included, each
-- once — so a model's page can list them all from those tables alone.
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
  -- The minutes a viewer needs to add her as a friend, as coomeet last
  -- sent it: high while she's popular, falling as that fades.
  current_balance smallint,
  -- The highest balance she's been seen with: how popular she's ever been.
  -- Premium, on the site, once it's above 10 (coomeet's floor).
  peak_balance smallint
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
  first_seen_at timestamptz not null default now(),
  -- The video as MP4, and a small animated WebP of it (coomeet calls it
  -- gif): CDN addresses of their own, not the webm's with another extension.
  mp4 text,
  gif text
);

alter table public.models
  add foreign key (current_story_id) references public.stories (id)
  on delete set null;

create index stories_model_id_published_at_idx
  on public.stories (model_id, published_at desc);

-- For the site's Premium list, highest peak first.
create index models_peak_balance_idx
  on public.models (peak_balance desc nulls last);

/* ===================== ACCESS ===================== */

alter table public.models enable row level security;
alter table public.names enable row level security;
alter table public.avatars enable row level security;
alter table public.stories enable row level security;

create policy "Anyone can read models" on public.models
  for select to anon, authenticated using (true);
create policy "Anyone can read names" on public.names
  for select to anon, authenticated using (true);
create policy "Anyone can read avatars" on public.avatars
  for select to anon, authenticated using (true);
create policy "Anyone can read stories" on public.stories
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
