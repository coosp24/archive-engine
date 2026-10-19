import supabase from "../util/supabase.js";

// Saves a batch of stories as the run saw them, and marks the models in
// `seen` as seen again — those in `seenOnline` online, the rest not —
// in one round trip (see record_stories in supabase/online.sql). Answers how
// many of each were new to the archive: { model, name, avatar, story }.
export const recordStories = async (stories, seen = [], seenOnline = []) => {
  const { data, error } = await supabase.rpc("record_stories", {
    p_stories: stories.map(({ id, name, avatar, storyId, src, preview, published, online }) => ({
      model_id: id,
      name,
      avatar,
      story_id: storyId,
      story: src,
      preview,
      published_at: published ? new Date(published).toISOString() : null,
      online,
    })),
    p_seen: seen,
    p_seen_online: seenOnline,
  });

  if (error) throw new Error(error.message);
  return data;
};

// A single request returns at most this many rows (PostgREST's default cap).
const PAGE = 1000;

// Every model as the archive has her now — her current name, avatar and
// story — keyed by id, so the run can tell which stories bring nothing new.
export const getKnownModels = async () => {
  const known = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("models")
      .select("id, current_name, current_avatar, current_story_id")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`❌ Failed to load known models: ${error.message}`);
    for (const m of data) {
      known.set(String(m.id), {
        name: m.current_name,
        avatar: m.current_avatar,
        storyId: m.current_story_id == null ? null : String(m.current_story_id),
      });
    }
    if (data.length < PAGE) return known;
  }
};
