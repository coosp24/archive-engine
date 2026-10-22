import supabase from "./client.js";

// Where the face indexer (src/faces/indexer.js) gets a site's images and
// saves their faces: the site's own <site>_faces_todo and
// <site>_record_faces (supabase/<site>/faces.sql), the same for every site.
export function facesStore(site) {
  return {
    // The next images to look at, newest first: [{ source, source_id,
    // model_id, image, capped }].
    async todo(limit) {
      const { data, error } = await supabase.rpc(`${site}_faces_todo`, { p_limit: limit });
      if (error) throw new Error(`Failed to fetch images to scan: ${error.message}`);
      return data;
    },
    // Saves a batch of scanned images and their faces in one round trip.
    // Answers how many were new: { scanned, faces }.
    async record(scans) {
      const { data, error } = await supabase.rpc(`${site}_record_faces`, { p_scans: scans });
      if (error) throw new Error(`Failed to save faces: ${error.message}`);
      return data;
    },
  };
}
