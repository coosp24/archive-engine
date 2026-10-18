import supabase from "../util/supabase.js";

// Saves one story as the run saw it (see record_story in
// supabase/schema.sql). Answers which parts were new to the archive:
// { model, name, avatar, story }.
export const recordStory = async ({ id, name, avatar, storyId, src, preview, published }) => {
  const { data, error } = await supabase.rpc("record_story", {
    p_model_id: id,
    p_name: name,
    p_avatar: avatar,
    p_story_id: storyId,
    p_story: src,
    p_preview: preview,
    p_published_at: published ? new Date(published).toISOString() : null,
  });

  if (error) {
    throw new Error(`❌ Failed to save story for model ${id}: ${error.message}`);
  }
  return data;
};
