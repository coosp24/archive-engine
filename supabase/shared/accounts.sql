-- The accounts the engine logs in with, one site's or more, edited here in
-- the database instead of in .env. Run in the Supabase SQL editor, after
-- setup.sql (see supabase/README.md). Safe to re-run.
--
-- For each site, the engine logs in with its one row marked is_primary. To
-- switch a site's account, add the new one and move the flag:
--
--   insert into public.accounts (site, email, password) values ('coomeet', '…', '…');
--   update public.accounts set is_primary = (email = '…') where site = 'coomeet';
--
-- With no row of a site marked primary, its runs go ahead as a guest
-- (logged out):
--
--   update public.accounts set is_primary = false where site = 'coomeet';
--
-- No --guest run reads this table.

/* ===================== TABLE ===================== */

create table if not exists public.accounts (
  id bigint generated always as identity primary key,
  -- Which site the account is on: its id in the engine's src/sites/.
  site text not null,
  email text not null,
  password text not null,
  -- The account the engine logs in with. At most one per site.
  is_primary boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  unique (site, email)
);

create unique index if not exists accounts_one_primary_per_site
  on public.accounts (site) where is_primary;

/* ===================== ACCESS ===================== */

-- Passwords: nobody but the engine reads this. RLS on with no policies hides
-- every row from the anon and authenticated keys; the engine's secret key
-- bypasses RLS.
alter table public.accounts enable row level security;
revoke all on public.accounts from anon, authenticated;
