import supabase from "../../db/client.js";

// luckycrush's tables (supabase/luckycrush/): its models and what's been
// seen of them. Every call goes through a luckycrush_* function or table, so
// another site's data never mixes with luckycrush's. Its faces:
// src/db/faces.js.

// Saves the models a run saw recommended (shaped as in ./model.js), in one
// round trip. Answers how many of each were new: { model, name, avatar }.
export async function recordModels(models) {
  const { data, error } = await supabase.rpc("luckycrush_record_models", {
    p_models: models.map((m) => ({ model_id: m.modelId, name: m.name, avatar: m.avatar })),
  });
  if (error) throw new Error(error.message);
  return data;
}
