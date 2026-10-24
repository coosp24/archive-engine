-- luckycrush's tables, and the function the engine saves its runs through.
-- Run in the Supabase SQL editor, after supabase/shared/ (see
-- supabase/README.md). Safe to re-run.
--
-- luckycrush is a random video chat with no stories or profiles: all it
-- shows of its models is the ones it recommends to a signed-up man, those
-- free for a call at the moment — her id, name and avatar. So
-- luckycrush_models holds each model as she is now, and luckycrush_names and
-- luckycrush_avatars collect every name and avatar she has been seen with,
-- each once. luckycrush_stories stays empty: it's there so every site has
-- the same tables (the site and the analysis functions read them all alike).
--
-- Everyone can read; only the engine writes, with the secret key (which
-- bypasses RLS), through luckycrush_record_models() below.

/* ===================== TABLES ===================== */

create table if not exists public.luckycrush_models (
  -- luckycrush's id for her (its "uhidB"): letters, digits, _ and -; 20 of
  -- them as seen so far, but not held to that.
  id text primary key check (id ~ '^[A-Za-z0-9_-]{10,40}$'),
  -- luckycrush doesn't say when an account was made. Kept so every site's
  -- models have the same columns; always null.
  account_created_at timestamptz,
  current_name text,
  -- Her avatar, the larger size luckycrush has (500 px).
  current_avatar text,
  -- No stories: always null, kept for the same columns as every site's.
  current_story_id bigint,
  current_story text,
  current_story_preview text,
  current_story_published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- When a run last saw her free for a call (recommended to it) — the site
  -- calls her active while it's within the last hour (as for coomeet). Not
  -- cleared: luckycrush never says she's offline, she just isn't
  -- recommended.
  last_online_at timestamptz
);

-- The first version held ids to exactly 20 characters.
alter table public.luckycrush_models drop constraint if exists luckycrush_models_id_check;
alter table public.luckycrush_models
  add constraint luckycrush_models_id_check check (id ~ '^[A-Za-z0-9_-]{10,40}$');

-- Every name she has had, each once.
create table if not exists public.luckycrush_names (
  id bigint generated always as identity primary key,
  model_id text not null references public.luckycrush_models (id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, name)
);

-- Every avatar she has had, each once.
create table if not exists public.luckycrush_avatars (
  id bigint generated always as identity primary key,
  model_id text not null references public.luckycrush_models (id) on delete cascade,
  avatar text not null,
  first_seen_at timestamptz not null default now(),
  unique (model_id, avatar)
);

-- Always empty (see above).
create table if not exists public.luckycrush_stories (
  id bigint primary key,
  model_id text not null references public.luckycrush_models (id) on delete cascade,
  story text not null,
  preview text,
  published_at timestamptz,
  first_seen_at timestamptz not null default now()
);

-- For a "Recently active" filter.
create index if not exists luckycrush_models_last_online_at_idx
  on public.luckycrush_models (last_online_at desc nulls last);
-- For the site's models list: its default order (newest story) and "Recently
-- added" ones, each ending on the id as the list does, and when the engine
-- last saw anyone.
create index if not exists luckycrush_models_current_story_published_at_idx
  on public.luckycrush_models (current_story_published_at desc nulls last, id desc);
create index if not exists luckycrush_models_first_seen_at_idx
  on public.luckycrush_models (first_seen_at, id);
create index if not exists luckycrush_models_last_seen_at_idx
  on public.luckycrush_models (last_seen_at desc);
-- For the analysis page's days (luckycrush_analysis_daily): what each table
-- gained when.
create index if not exists luckycrush_names_first_seen_at_idx on public.luckycrush_names (first_seen_at);
create index if not exists luckycrush_avatars_first_seen_at_idx on public.luckycrush_avatars (first_seen_at);
create index if not exists luckycrush_stories_first_seen_at_idx on public.luckycrush_stories (first_seen_at);

/* ===================== ACCESS ===================== */

alter table public.luckycrush_models enable row level security;
alter table public.luckycrush_names enable row level security;
alter table public.luckycrush_avatars enable row level security;
alter table public.luckycrush_stories enable row level security;

drop policy if exists "Anyone can read models" on public.luckycrush_models;
create policy "Anyone can read models" on public.luckycrush_models
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read names" on public.luckycrush_names;
create policy "Anyone can read names" on public.luckycrush_names
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read avatars" on public.luckycrush_avatars;
create policy "Anyone can read avatars" on public.luckycrush_avatars
  for select to anon, authenticated using (true);
drop policy if exists "Anyone can read stories" on public.luckycrush_stories;
create policy "Anyone can read stories" on public.luckycrush_stories
  for select to anon, authenticated using (true);

/* ===================== WRITING ===================== */

-- Saves the models a run saw recommended, in one round trip:
-- p_models = [{ model_id, name, avatar }]. Each one's row is created on
-- first sight and marked seen — and, as she was free for a call, online now
-- — her name and avatar brought up to date and added to their collections
-- if they're new there. Answers how many of each were new: { model, name,
-- avatar }.
create or replace function public.luckycrush_record_models(p_models jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  p jsonb;
  v_id text;
  totals jsonb := jsonb_build_object('model', 0, 'name', 0, 'avatar', 0);
  bump text[];
begin
  for p in select * from jsonb_array_elements(coalesce(p_models, '[]'::jsonb)) loop
    v_id := p->>'model_id';
    bump := array[]::text[];

    insert into luckycrush_models (id) values (v_id) on conflict (id) do nothing;
    if found then bump := array_append(bump, 'model'); end if;

    update luckycrush_models m set
      last_seen_at = now(),
      last_online_at = now(),
      current_name = coalesce(p->>'name', m.current_name),
      current_avatar = coalesce(p->>'avatar', m.current_avatar)
    where m.id = v_id;

    if p->>'name' is not null then
      insert into luckycrush_names (model_id, name) values (v_id, p->>'name') on conflict do nothing;
      if found then bump := array_append(bump, 'name'); end if;
    end if;

    if p->>'avatar' is not null then
      insert into luckycrush_avatars (model_id, avatar) values (v_id, p->>'avatar') on conflict do nothing;
      if found then bump := array_append(bump, 'avatar'); end if;
    end if;

    for i in 1 .. coalesce(array_length(bump, 1), 0) loop
      totals := jsonb_set(totals, array[bump[i]], to_jsonb((totals->>bump[i])::int + 1));
    end loop;
  end loop;
  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.luckycrush_record_models(jsonb) from public, anon, authenticated;
grant execute on function public.luckycrush_record_models(jsonb) to service_role;
