-- Her peak balance instead of a log of every balance. Run once in the
-- Supabase SQL editor, after media-balance.sql (schema.sql has the same end
-- state for a fresh setup). Safe to re-run.
--
-- models.current_balance is how popular she is now; models.peak_balance,
-- new here, the highest she's ever been seen at — for the site's "popular
-- now" and "top all time" lists. The balances table, a row per change,
-- is dropped: the peak is all the site needs from it. It's filled from that
-- table first, so no peak seen so far is lost.

begin;

alter table public.models add column if not exists peak_balance smallint;

-- Only while the log is still there to read (a re-run finds it gone).
do $$
begin
  if to_regclass('public.balances') is not null then
    update models m set peak_balance = greatest(m.peak_balance, b.peak)
    from (select model_id, max(balance) peak from balances group by model_id) b
    where b.model_id = m.id;
  end if;
end;
$$;

update models set peak_balance = current_balance
where current_balance is not null
  and (peak_balance is null or peak_balance < current_balance);

create index if not exists models_peak_balance_idx
  on public.models (peak_balance desc nulls last);

drop table if exists public.balances;

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

commit;
