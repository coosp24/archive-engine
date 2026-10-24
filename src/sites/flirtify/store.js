import supabase from "../../db/client.js";

// flirtify's tables (supabase/flirtify/): its models and what's been seen
// of them. Every call goes through a flirtify_* function or table, so
// another site's data never mixes with flirtify's. Its faces:
// src/db/faces.js.

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
