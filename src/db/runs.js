import supabase from "./client.js";

// The runs table (supabase/shared/runs.sql): the scrape log the site's
// analysis page shows. A run that can't be logged still did its work, so a
// failure here is only a warning.

// Saves a run's report as soon as its stories are done. Answers the row's
// id, for its faces to be added later (addRunFaces), or null if it couldn't
// be saved.
export async function saveRun(run) {
  const { data, error } = await supabase
    .from("runs")
    .insert({
      site: run.site,
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: new Date(run.finishedAt).toISOString(),
      status: run.error ? "failed" : "ok",
      error: run.error ?? null,
      source: process.env.CI === "true" ? "github" : "local",
      method: run.method,
      guest: run.guest ?? null,
      story_limit: run.limit ?? null,
      stories_found: run.storiesFound ?? null,
      owner_unknown: run.ownerUnknown ?? null,
      saved: run.saved ?? null,
      skipped: run.skipped ?? null,
      failed_saves: run.failedSaves ?? null,
      new_models: run.newModels ?? null,
      new_stories: run.newStories ?? null,
      new_names: run.newNames ?? null,
      new_avatars: run.newAvatars ?? null,
      data_mb: run.dataMB ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.warn(`⚠️ Failed to log the run: ${error.message}`);
    return null;
  }
  return data.id;
}

// What the run's site fingerprinted for face search after the stories.
export async function addRunFaces(id, { scanned, faces }) {
  if (id == null) return;
  const { error } = await supabase.from("runs").update({ faces_scanned: scanned, faces_found: faces }).eq("id", id);
  if (error) console.warn(`⚠️ Failed to log the run's faces: ${error.message}`);
}
