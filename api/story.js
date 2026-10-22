import supabase from "../util/supabase.js";

// Saves a batch of stories as the run saw them, and marks the models in
// `seen` as seen again, in one round trip (see record_stories in
// supabase/media-balance.sql). Answers how many of each were new to the
// archive: { model, name, avatar, story, balance } — `balance` counting
// balances that changed.
export const recordStories = async (stories, seen = []) => {
  const { data, error } = await supabase.rpc("record_stories", {
    p_stories: stories.map(
      ({ id, name, avatar, storyId, src, preview, published, mp4, gif, balance }) => ({
        model_id: id,
        name,
        avatar,
        story_id: storyId,
        story: src,
        preview,
        published_at: published ? new Date(published).toISOString() : null,
        mp4: mp4 ?? null,
        gif: gif ?? null,
        balance: balance ?? null,
      }),
    ),
    p_seen: seen,
  });

  if (error) throw new Error(error.message);
  return data;
};

// A single request returns at most this many rows (PostgREST's default cap).
const PAGE = 1000;

// Every model as the archive has her now — her current name, avatar, story
// and balance, and whether that story has its MP4 yet — keyed by id, so the
// run can tell which stories bring nothing new. The story is read through
// models.current_story_id (stories also points back at models, hence the
// key's name).
export const getKnownModels = async () => {
  const known = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("models")
      .select(
        "id, current_name, current_avatar, current_story_id, current_balance, current:stories!models_current_story_id_fkey(mp4)",
      )
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`❌ Failed to load known models: ${error.message}`);
    for (const m of data) {
      known.set(String(m.id), {
        name: m.current_name,
        avatar: m.current_avatar,
        storyId: m.current_story_id == null ? null : String(m.current_story_id),
        balance: m.current_balance,
        hasMp4: Boolean(m.current?.mp4),
      });
    }
    if (data.length < PAGE) return known;
  }
};
