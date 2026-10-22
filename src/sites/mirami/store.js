import supabase from "../../db/client.js";

// mirami's tables (supabase/mirami/): its models and what's been seen of
// them. Every call goes through a mirami_* function or table, so another
// site's data never mixes with mirami's. Its faces: src/db/faces.js.

// Saves a batch of reels as the run saw them (merged as in ./girl.js), in
// one round trip. Answers how many of each were new: { model, name,
// avatar, story }.
export async function recordStories(reels) {
  const { data, error } = await supabase.rpc("mirami_record_stories", {
    p_stories: reels.map((r) => ({
      model_id: r.modelId,
      ref_code: r.refCode,
      name: r.name,
      profile_name: r.profileName,
      avatar: r.avatar,
      online: r.online,
      site_last_visit_at: r.siteLastVisitAt,
      country: r.country,
      birthday: r.birthday,
      age: r.age,
      verified: r.verified,
      about: r.about,
      likes_count: r.likesCount,
      favourites_count: r.favouritesCount,
      gifts_count: r.giftsCount,
      shows_count: r.showsCount,
      story_id: r.storyId,
      story: r.src,
      preview: r.preview,
      likes: r.likes,
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}

// Saves a batch of gallery photos (shaped as in ./girl.js), in one round
// trip. Answers how many were new: { photo }.
export async function recordPhotos(photos) {
  const { data, error } = await supabase.rpc("mirami_record_photos", {
    p_photos: photos.map((p) => ({
      id: p.id,
      model_id: p.modelId,
      kind: p.kind,
      premium: p.premium,
      image: p.image,
      original: p.original,
      posted_at: p.postedAt,
      likes: p.likes,
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}
