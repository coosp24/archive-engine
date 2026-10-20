-- Face search: the faces in the archive's avatars and story previews, with
-- a fingerprint to find each by. Run in the Supabase SQL editor, after
-- runs.sql. Safe to re-run — and run again it upgrades an older version in
-- place (see UPGRADE below).
--
-- The engine (util/faces.js) finds the faces in each image and turns each
-- into 512 numbers — close for the same person, far apart for different
-- people — and saves them here through record_faces(). The site
-- fingerprints a photo the same way, in the browser, and asks
-- match_faces() for the closest.
--
-- To fit the free plan's 500 MB, the fingerprints are kept at half
-- precision (halfvec: 1 KB each, matching just as well), and a model keeps
-- every avatar's face but at most STORY_FACES faces from her stories,
-- each unlike the others she has: past that, her new stories aren't even
-- downloaded. So the faces grow with the number of models, not of stories.
--
-- Fingerprints are only ever read through match_faces(): the tables
-- themselves aren't readable with the public key.

-- Rewriting the table and building its index take a while on the free
-- plan: more than the SQL editor's usual limit.
set statement_timeout = '15min';

create extension if not exists vector with schema extensions;

/* ===================== TABLES ===================== */

-- Every image the engine has looked at, with or without a face in it, so
-- none is looked at twice. `source` is which table it's from: an avatar
-- (avatars.id) or a story's preview (stories.id).
create table if not exists public.face_scans (
  source text not null check (source in ('avatar', 'story')),
  source_id bigint not null,
  model_id bigint not null references public.models (id) on delete cascade,
  -- Faces the detector found in it (not all of them are kept: see above).
  faces smallint not null default 0,
  -- Why the image couldn't be read, when it couldn't (gone, not an image).
  error text,
  scanned_at timestamptz not null default now(),
  primary key (source, source_id)
);

-- Passed over without being downloaded: the model had all the story faces
-- she keeps already.
alter table public.face_scans add column if not exists capped boolean not null default false;

-- One row per face kept.
create table if not exists public.faces (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.models (id) on delete cascade,
  source text not null,
  source_id bigint not null,
  image text not null,
  -- Where the face is in the image, in its pixels: [x1, y1, x2, y2].
  box integer[] not null,
  -- How sure the detector was that it's a face, 0–1.
  score real not null,
  -- The fingerprint, of length 1: similarity is 1 − cosine distance.
  embedding extensions.halfvec(512) not null,
  created_at timestamptz not null default now(),
  foreign key (source, source_id) references public.face_scans (source, source_id) on delete cascade
);

/* ===================== UPGRADE ===================== */

-- The first version kept every face, at full precision. Story faces past
-- a model's 10 best (by the detector's score) go, then the rest are
-- rewritten at half precision — which also gives the space back.
do $$
begin
  if (
    select atttypid from pg_attribute
    where attrelid = 'public.faces'::regclass and attname = 'embedding'
  ) = 'extensions.vector'::regtype then
    delete from public.faces f
    using (
      select id, row_number() over (partition by model_id order by score desc, id) as n
      from public.faces
      where source = 'story'
    ) ranked
    where ranked.id = f.id and ranked.n > 10;

    drop index if exists public.faces_embedding_idx;
    alter table public.faces
      alter column embedding type extensions.halfvec(512)
      using embedding::extensions.halfvec(512);
  end if;
end;
$$;

create index if not exists faces_embedding_idx
  on public.faces using hnsw (embedding extensions.halfvec_cosine_ops);
create index if not exists faces_model_id_idx on public.faces (model_id, source);

alter table public.face_scans enable row level security;
alter table public.faces enable row level security;

-- What each run fingerprinted, for the scrape log.
alter table public.runs
  add column if not exists faces_scanned integer,
  add column if not exists faces_found integer;

-- The engine's own calls (its secret key) may take up to a minute: saving a
-- batch of faces means adding them to the index, which on the free plan's
-- throttled disk can take several seconds. The site's key keeps its limit.
-- (Should Supabase not allow it, the rest goes ahead without it.)
do $$
begin
  execute 'alter role service_role set statement_timeout = ''60s''';
exception when others then
  raise notice 'The engine''s time limit stays as it was: %', sqlerrm;
end;
$$;
notify pgrst, 'reload config';

/* ===================== THE ENGINE ===================== */

-- How many story faces a model keeps, and how alike (0–1) a new one may be
-- to one she has and still be kept: past it, it's the same look again.
create or replace function public.faces_story_cap() returns int
language sql immutable as $$ select 10 $$;
create or replace function public.faces_same_look() returns real
language sql immutable as $$ select 0.8::real $$;

-- The next p_limit images to look at, newest first — so each run's new
-- avatars and previews are done before the backlog: [{ source, source_id,
-- model_id, image, capped }]. `capped`: a story of a model who has all her
-- story faces already, to be passed over without downloading it.
drop function if exists public.faces_todo(int);
create or replace function public.faces_todo(p_limit int default 100)
returns table (source text, source_id bigint, model_id bigint, image text, capped boolean)
language sql
stable
set search_path = public
as $$
  select x.source, x.source_id, x.model_id, x.image,
    x.source = 'story' and (
      select count(*) from faces f where f.model_id = x.model_id and f.source = 'story'
    ) >= faces_story_cap()
  from (
    select 'avatar'::text as source, a.id as source_id, a.model_id, a.avatar as image, a.first_seen_at
    from avatars a
    where not exists (
      select 1 from face_scans f where f.source = 'avatar' and f.source_id = a.id
    )
    union all
    select 'story', s.id, s.model_id, s.preview, s.first_seen_at
    from stories s
    where s.preview is not null
      and not exists (
        select 1 from face_scans f where f.source = 'story' and f.source_id = s.id
      )
  ) x
  order by x.first_seen_at desc, x.source_id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- Saves what the engine found in a batch of images, in one round trip:
-- p_scans = [{ source, source_id, model_id, image, error, capped,
--              faces: [{ box, score, embedding }] }, …].
-- Every image is recorded as looked at. Its faces are kept — an avatar's
-- always; a story's only while the model has fewer than faces_story_cap()
-- story faces (the surest of the batch first), and only when unlike any
-- she has. An image already saved is left as it is. One statement, so a
-- batch is saved whole or not at all. Answers { scanned, faces }: images
-- recorded, faces kept.
create or replace function public.record_faces(p_scans jsonb)
returns jsonb
language sql
set search_path = public, extensions
as $$
  with input as (
    select *
    from jsonb_to_recordset(coalesce(p_scans, '[]'::jsonb))
      as x(source text, source_id bigint, model_id bigint, image text, error text,
           capped boolean, faces jsonb)
  ),
  new_scans as (
    insert into face_scans (source, source_id, model_id, faces, error, capped)
    select source, source_id, model_id, coalesce(jsonb_array_length(faces), 0), error,
      coalesce(capped, false)
    from input
    on conflict do nothing
    returning source, source_id
  ),
  found as (
    select i.model_id, i.source, i.source_id, i.image,
      array(select jsonb_array_elements_text(f->'box')::int) as box,
      (f->>'score')::real as score,
      (f->>'embedding')::halfvec(512) as embedding
    from input i
    join new_scans n on n.source = i.source and n.source_id = i.source_id
    cross join lateral jsonb_array_elements(coalesce(i.faces, '[]'::jsonb)) f
  ),
  -- A story face that's the same look as one she has already isn't kept.
  fresh as (
    select fd.*
    from found fd
    where fd.source = 'avatar'
      or not exists (
        select 1 from faces f
        where f.model_id = fd.model_id
          and 1 - (f.embedding <=> fd.embedding) >= faces_same_look()
      )
  ),
  -- Story faces, the surest first, up to what the model has room for.
  ranked as (
    select fr.*,
      row_number() over (partition by fr.model_id, fr.source order by fr.score desc) as n,
      (select count(*) from faces f where f.model_id = fr.model_id and f.source = 'story') as has
    from fresh fr
  ),
  new_faces as (
    insert into faces (model_id, source, source_id, image, box, score, embedding)
    select model_id, source, source_id, image, box, score, embedding
    from ranked
    where source = 'avatar' or has + n <= faces_story_cap()
    returning 1
  )
  select jsonb_build_object(
    'scanned', (select count(*) from new_scans),
    'faces', (select count(*) from new_faces)
  );
$$;

/* ===================== THE SITE ===================== */

-- The models whose faces are closest to p_embedding (a fingerprint from
-- the same model, of length 1), best first, one row each: her best-matching
-- face — its image and box — how alike it is (similarity, 0–1), and how
-- many of her faces matched at all. Faces below p_min don't count.
drop function if exists public.match_faces(extensions.vector, int, real);
create or replace function public.match_faces(
  p_embedding extensions.halfvec(512),
  p_limit int default 24,
  p_min real default 0.25
)
returns table (
  model_id bigint,
  name text,
  avatar text,
  similarity real,
  image text,
  box integer[],
  source text,
  matched bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  -- Look further through the index than the default, for better recall.
  perform set_config('hnsw.ef_search', '200', true);
  return query
  with nearest as (
    select f.model_id, f.image, f.box, f.source,
      (1 - (f.embedding <=> p_embedding))::real as similarity
    from faces f
    order by f.embedding <=> p_embedding
    limit 400
  ),
  good as (
    select * from nearest n where n.similarity >= p_min
  ),
  best as (
    select distinct on (g.model_id) g.*
    from good g
    order by g.model_id, g.similarity desc
  )
  select b.model_id, m.current_name, m.current_avatar, b.similarity, b.image, b.box, b.source,
    (select count(*) from good g where g.model_id = b.model_id)
  from best b
  join models m on m.id = b.model_id
  order by b.similarity desc
  limit least(greatest(coalesce(p_limit, 24), 1), 50);
end;
$$;

/* ===================== ACCESS ===================== */

-- The engine (secret key) fills the tables; the site only asks for matches.
revoke execute on function public.faces_todo(int) from public, anon, authenticated;
revoke execute on function public.record_faces(jsonb) from public, anon, authenticated;
grant execute on function public.faces_todo(int) to service_role;
grant execute on function public.record_faces(jsonb) to service_role;
grant execute on function public.match_faces(extensions.halfvec, int, real) to anon, authenticated;
