-- The coomeet account the engine logs in with, edited here in the database
-- instead of in .env. Run once in the Supabase SQL editor. Safe to re-run.
--
-- The engine logs in with the one row marked is_primary. To switch accounts,
-- add the new one and move the flag:
--
--   insert into public.accounts (email, password) values ('…', '…');
--   update public.accounts set is_primary = (email = '…');
--
-- With no row marked primary, runs go ahead as a guest (logged out):
--
--   update public.accounts set is_primary = false;
--
-- No --guest run reads this table.

/* ===================== TABLE ===================== */

create table if not exists public.accounts (
  id bigint generated always as identity primary key,
  email text not null unique,
  password text not null,
  -- The account the engine logs in with. At most one row can be primary.
  is_primary boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);

create unique index if not exists accounts_one_primary
  on public.accounts (is_primary) where is_primary;

/* ===================== ACCESS ===================== */

-- Passwords: nobody but the engine reads this. RLS on with no policies hides
-- every row from the anon and authenticated keys; the engine's secret key
-- bypasses RLS.
alter table public.accounts enable row level security;
revoke all on public.accounts from anon, authenticated;
