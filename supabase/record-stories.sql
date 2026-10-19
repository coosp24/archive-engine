-- Batch saving, for runs that save many stories at once. Run once in the
-- Supabase SQL editor (it's also part of schema.sql for a fresh setup).
--
-- record_stories() saves a list of stories in one round trip, each through
-- record_story(), and marks as seen again the models the engine skipped
-- because nothing about them had changed.
--
-- p_stories: [{ model_id, name, avatar, story_id, story, preview,
--               published_at }, …]
-- p_seen:    ids of the models seen but not sent
--
-- Answers how many of each were new: { model, name, avatar, story }.
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
  totals jsonb := jsonb_build_object('model', 0, 'name', 0, 'avatar', 0, 'story', 0);
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
      (item->>'published_at')::timestamptz
    );
    foreach kind in array array['model', 'name', 'avatar', 'story'] loop
      if (result->>kind)::boolean then
        totals := jsonb_set(totals, array[kind], to_jsonb((totals->>kind)::int + 1));
      end if;
    end loop;
  end loop;

  if cardinality(p_seen) > 0 then
    update models set last_seen_at = now() where id = any(p_seen);
  end if;

  return totals;
end;
$$;

-- Only the engine (secret key = service_role) may write.
revoke execute on function public.record_stories(jsonb, bigint[])
  from public, anon, authenticated;
grant execute on function public.record_stories(jsonb, bigint[])
  to service_role;
