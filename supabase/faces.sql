-- Face search: every face in the archive's avatars and story previews, with
-- a fingerprint to find it by. Run once in the Supabase SQL editor, after
-- runs.sql. Safe to re-run.
--
-- The engine (util/faces.js) finds the faces in each image and turns each
-- into 512 numbers — close for the same person, far apart for different
-- people — and saves them here through record_faces(). The site
-- fingerprints a photo the same way, in the browser, and asks
-- match_faces() for the closest.
--
-- Fingerprints are only ever read through match_faces(): the tables
-- themselves aren't readable with the public key.

create extension if not exists vector with schema extensions;

/* ===================== TABLES ===================== */

-- Every image the engine has looked at, with or without a face in it, so
-- none is looked at twice. `source` is which table it's from: an avatar
-- (avatars.id) or a story's preview (stories.id).
create table if not exists public.face_scans (
  source text not null check (source in ('avatar', 'story')),
  source_id bigint not null,
  model_id bigint not null references public.models (id) on delete cascade,
  faces smallint not null default 0,
  -- Why the image couldn't be read, when it couldn't (gone, not an image).
  error text,
  scanned_at timestamptz not null default now(),
  primary key (source, source_id)
);

-- One row per face found.
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
  embedding extensions.vector(512) not null,
  created_at timestamptz not null default now(),
  foreign key (source, source_id) references public.face_scans (source, source_id) on delete cascade
);

create index if not exists faces_embedding_idx
  on public.faces using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists faces_model_id_idx on public.faces (model_id);

alter table public.face_scans enable row level security;
alter table public.faces enable row level security;

-- What each run fingerprinted, for the scrape log.
alter table public.runs
  add column if not exists faces_scanned integer,
  add column if not exists faces_found integer;

/* ===================== THE ENGINE ===================== */

-- The next p_limit images to look at, newest first — so each run's new
-- avatars and previews are done before the backlog: [{ source, source_id,
-- model_id, image }].
create or replace function public.faces_todo(p_limit int default 100)
returns table (source text, source_id bigint, model_id bigint, image text)
language sql
stable
set search_path = public
as $$
  select x.source, x.source_id, x.model_id, x.image
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
-- p_scans = [{ source, source_id, model_id, image, error,
--              faces: [{ box, score, embedding }] }, …].
-- An image already saved is left as it is, faces and all. One statement,
-- so a batch is saved whole or not at all. Answers { scanned, faces }.
create or replace function public.record_faces(p_scans jsonb)
returns jsonb
language sql
set search_path = public, extensions
as $$
  with input as (
    select *
    from jsonb_to_recordset(coalesce(p_scans, '[]'::jsonb))
      as x(source text, source_id bigint, model_id bigint, image text, error text, faces jsonb)
  ),
  new_scans as (
    insert into face_scans (source, source_id, model_id, faces, error)
    select source, source_id, model_id, coalesce(jsonb_array_length(faces), 0), error
    from input
    on conflict do nothing
    returning source, source_id
  ),
  new_faces as (
    insert into faces (model_id, source, source_id, image, box, score, embedding)
    select i.model_id, i.source, i.source_id, i.image,
      array(select jsonb_array_elements_text(f->'box')::int),
      (f->>'score')::real,
      (f->>'embedding')::vector
    from input i
    join new_scans n on n.source = i.source and n.source_id = i.source_id
    cross join lateral jsonb_array_elements(coalesce(i.faces, '[]'::jsonb)) f
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
create or replace function public.match_faces(
  p_embedding extensions.vector(512),
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
grant execute on function public.match_faces(extensions.vector, int, real) to anon, authenticated;
