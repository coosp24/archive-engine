import supabase from "../../db/client.js";

// flirtbees' tables (supabase/flirtbees/): its models and what's been seen
// of them. Every call goes through a flirtbees_* function or table, so
// another site's data never mixes with flirtbees'.

// Saves a batch of stories as the run saw them (shaped as in ./story.js,
// with `avatar` the full-size one kept), in one round trip. Answers how
// many of each were new: { model, name, avatar, story }.
export async function recordStories(stories) {
  const { data, error } = await supabase.rpc("flirtbees_record_stories", {
    p_stories: stories.map((s) => ({
      model_id: s.modelId,
      model_uid: s.modelUid,
      name: s.name,
      avatar: s.avatar,
      online: s.online,
      site_last_online_at: s.siteLastOnlineAt,
      story_id: s.storyId,
      story_uid: s.storyUid,
      story: s.src,
      mp4: s.mp4,
      preview: s.preview,
      published_at: s.published,
      likes: s.likes,
      points: s.points,
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}

// A single request returns at most this many rows (PostgREST's default cap).
const PAGE = 1000;

// Every model's current avatar as the archive has it, keyed by her id — so
// the run only works out the full size of an avatar it hasn't kept yet.
export async function getKnownAvatars() {
  const known = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("flirtbees_models")
      .select("id, current_avatar")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load known models: ${error.message}`);
    for (const m of data) if (m.current_avatar) known.set(m.id, m.current_avatar);
    if (data.length < PAGE) return known;
  }
}
