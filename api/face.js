import supabase from "../util/supabase.js";

// The next images to look for faces in, newest first (see faces_todo in
// supabase/faces.sql): [{ source, source_id, model_id, image }].
export const getFaceTodo = async (limit) => {
  const { data, error } = await supabase.rpc("faces_todo", { p_limit: limit });
  if (error) throw new Error(`❌ Failed to fetch images to scan: ${error.message}`);
  return data;
};

// Saves a batch of scanned images and the faces found in them, in one round
// trip (record_faces). Answers how many were new: { scanned, faces }.
export const recordFaces = async (scans) => {
  const { data, error } = await supabase.rpc("record_faces", { p_scans: scans });
  if (error) throw new Error(`❌ Failed to save faces: ${error.message}`);
  return data;
};
