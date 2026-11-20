import supabase from "../../db/client.js";

// flirtify's tables (supabase/flirtify/): its models and what's been seen
// of them. Every call goes through a flirtify_* function or table, so
// another site's data never mixes with flirtify's. Its faces:
// src/db/faces.js.

// A single request returns at most this many rows (PostgREST's default cap).
const PAGE = 1000;

// Every model the archive has, by id, with her current story's id (null
// when she has none): what tells the run who has posted since.
export async function getCurrentStories() {
  const current = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("flirtify_models")
      .select("id, current_story_id")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load known models: ${error.message}`);
    for (const m of data) current.set(m.id, m.current_story_id == null ? null : String(m.current_story_id));
    if (data.length < PAGE) return current;
  }
}

// Saves a batch of models as the run saw them (merged as in ./model.js),
// each with her stories, in one round trip. Answers how many of each were
// new: { model, name, avatar, story }.
export async function recordModels(models) {
  const { data, error } = await supabase.rpc("flirtify_record_models", {
    p_models: models.map((m) => ({
      model_id: m.modelId,
      int_id: m.intId,
      username: m.username,
      name: m.name,
      avatar: m.avatar,
      avatar_key: m.avatarKey,
      online: m.online,
      country: m.country,
      age_group: m.ageGroup,
      about: m.about,
      languages: m.languages,
      call_price_in_sec: m.callPrice,
      access: m.access,
      stories: m.stories.map((s) => ({
        story_id: s.storyId,
        uid: s.uid,
        slug: s.slug,
        story: s.src,
        preview: s.preview,
        published_at: s.published,
        orientation: s.orientation,
      })),
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}
