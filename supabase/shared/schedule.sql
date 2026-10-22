-- ============================================================================
-- Runs the archive every hour, on the hour, from Supabase.
--
-- pg_cron calls public.dispatch_archive() at minute 0 of every hour, and it
-- asks GitHub Actions to run .github/workflows/archive.yml through pg_net —
-- the same request as pressing "Run workflow" in the repo's Actions tab.
-- GitHub's own scheduled runs fire up to half an hour late (sometimes not at
-- all), which is why the clock lives here instead.
--
-- ----------------------------------------------------------------------------
-- BEFORE RUNNING THIS, store a GitHub token in Supabase Vault (once). Make it
-- a fine-grained personal access token for the coosp24 account, scoped to the
-- archive-engine repository only, with the single permission
-- "Actions: Read and write":
--
--   select vault.create_secret('github_pat_…', 'archive_github_token',
--                              'Dispatches the hourly archive run');
--
-- To replace it later (expired or revoked):
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'archive_github_token'),
--     'github_pat_…');
--
-- Run in Supabase → SQL Editor. Safe to re-run.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_archive()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token text;
  request_id bigint;
begin
  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'archive_github_token';
  if token is null then
    raise warning 'dispatch_archive: no archive_github_token in Vault; not dispatched';
    return null;
  end if;

  -- GitHub answers 204 when it accepts the run; the answer lands in
  -- net._http_response under the returned id.
  select net.http_post(
    url     := 'https://api.github.com/repos/coosp24/archive-engine/actions/workflows/archive.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'archive-engine-scheduler',
      'Content-Type', 'application/json'
    ),
    body    := jsonb_build_object('ref', 'main')
  ) into request_id;
  return request_id;
end;
$$;

-- Only the cron job (running as the database owner) calls this — never the
-- anon key or a signed-in visitor.
revoke all on function public.dispatch_archive() from public, anon, authenticated;

-- At minute 0 of every hour: 24 runs a day. Re-running this file replaces
-- the job rather than adding a second one.
select cron.schedule('archive-hourly', '0 * * * *', 'select public.dispatch_archive()');

-- ----------------------------------------------------------------------------
-- Handy afterwards:
--
--   select public.dispatch_archive();         -- start a run right now
--
--   select status_code, content, created      -- GitHub's answers (204 = ok)
--   from net._http_response order by created desc limit 5;
--
--   select cron.unschedule('archive-hourly'); -- stop the hourly runs
-- ============================================================================
