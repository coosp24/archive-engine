import supabase from "./client.js";

// Saves a run's report to the runs table (supabase/shared/runs.sql), the
// scrape log the site's analysis page shows. A run that can't be logged
// still did its work, so a failure here is only a warning.
export async function saveRun(run) {
  const { error } = await supabase.from("runs").insert({
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
    faces_scanned: run.facesScanned ?? null,
    faces_found: run.facesFound ?? null,
  });
  if (error) console.warn(`⚠️ Failed to log the run: ${error.message}`);
}
