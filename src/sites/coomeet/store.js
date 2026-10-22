import supabase from "../../db/client.js";

// coomeet's tables (supabase/coomeet/): its models and what's been seen of
// them, and their faces. Every call goes through a coomeet_* function or
// table, so another site's data never mixes with coomeet's.

// Saves a batch of stories as the run saw them (shaped as in ./story.js),
// and marks the models in `seen` as seen again — those in `seenOnline`
// online, those in `seenOffline` offline — in one round trip. Answers how
// many of each were new: { model, name, avatar, story, balance }, `balance`
// counting balances that changed.
export async function recordStories(stories, { seen, seenOnline, seenOffline }) {
  const { data, error } = await supabase.rpc("coomeet_record_stories", {
    p_stories: stories.map((s) => ({
      model_id: s.id,
      name: s.name,
      avatar: s.avatar,
      story_id: s.storyId,
      story: s.src,
      preview: s.preview,
      published_at: s.published ? new Date(s.published).toISOString() : null,
      mp4: s.mp4,
      gif: s.gif,
      balance: s.balance,
      online: s.online,
    })),
    p_seen: seen,
    p_seen_online: seenOnline,
    p_seen_offline: seenOffline,
  });
  if (error) throw new Error(error.message);
  return data;
}

// A single request returns at most this many rows (PostgREST's default cap).
const PAGE = 1000;

// Every model as the archive has her now — her current name, avatar, story
// and balance, and whether that story has its MP4 yet — keyed by id, so the
// run can tell which stories bring nothing new. The story is read through
// coomeet_models.current_story_id (stories also points back at models,
// hence naming the key).
export async function getKnownModels() {
  const known = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("coomeet_models")
      .select(
        "id, current_name, current_avatar, current_story_id, current_balance, current:coomeet_stories!coomeet_models_current_story_id_fkey(mp4)",
      )
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load known models: ${error.message}`);
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
}

// Where the face indexer (src/faces/indexer.js) gets coomeet's images and
// saves their faces.
export const faces = {
  // The next images to look at, newest first: [{ source, source_id,
  // model_id, image, capped }].
  async todo(limit) {
    const { data, error } = await supabase.rpc("coomeet_faces_todo", { p_limit: limit });
    if (error) throw new Error(`Failed to fetch images to scan: ${error.message}`);
    return data;
  },
  // Saves a batch of scanned images and their faces in one round trip.
  // Answers how many were new: { scanned, faces }.
  async record(scans) {
    const { data, error } = await supabase.rpc("coomeet_record_faces", { p_scans: scans });
    if (error) throw new Error(`Failed to save faces: ${error.message}`);
    return data;
  },
};
