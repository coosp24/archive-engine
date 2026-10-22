// mirami's reels and girls as its API sends them, turned into what the
// archive keeps. A reel (GET /v2/gallery/media/video/shorts):
//   { id, name, description, is_premium, is_published, on_processing,
//     video: { url, mime }, video_poster: { url, mime, width, height },
//     likes_count, is_liked, is_viewed,
//     user: { id, name, nick, country, sex, age, avatarUrl, refCode,
//             totalLikesCount, statusOnline } }
// Her profile (GET /girl_info?ref_code=…):
//   { user_id, nick, avatar_url, status, last_visit, about, birthday, age,
//     is_verify, count_likes, count_favourites, count_gifts, … }
// And mirami's girls lists (GET /girls, /girls/online), the only place
// with shows_count: { id, nick, ref_code, avatar_url, status, shows_count,
// likes_count, count_favourites, … }.
//
// Left out: the reel's name and description (always empty), is_premium
// (always false), is_published and on_processing (always the same), and
// is_liked, is_viewed and the girls' favourite/subscribed flags, which are
// about whoever is viewing.
//
// Her name is her nick: what mirami shows. Its other `name`, often a full
// name, is kept apart as profileName.

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
// Counts arrive as numbers or as strings of digits.
const count = (value) => {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const id = (value) => (count(value) === null ? null : String(count(value)));
// "online" and "busy" (in a call) are both online; "offline" isn't.
const onlineFrom = (status) => (status === "online" || status === "busy" ? true : status === "offline" ? false : null);
const date = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
// mirami's "2026-10-22 08:25:27.687546" — a time without a zone, in UTC.
const utc = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) return null;
  const iso = `${value.replace(" ", "T")}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
};

// { modelId, refCode, name, profileName, avatar, country, age, online,
//   storyId, src, preview, likes } — each null when the reel doesn't say.
export function shapeReel(r) {
  const user = r.user ?? {};
  return {
    modelId: id(user.id),
    refCode: text(user.refCode),
    name: text(user.nick),
    profileName: text(user.name),
    avatar: text(user.avatarUrl),
    country: text(user.country)?.toUpperCase() ?? null,
    age: count(user.age),
    online: onlineFrom(user.statusOnline),
    storyId: id(r.id),
    src: text(r.video?.url),
    preview: text(r.video_poster?.url),
    likes: count(r.likes_count),
  };
}

// What her profile adds: { name, avatar, online, siteLastVisitAt, about,
// birthday, age, verified, likesCount, favouritesCount, giftsCount } — each
// null when it doesn't say.
export function shapeInfo(g) {
  return {
    name: text(g.nick),
    avatar: text(g.avatar_url),
    online: onlineFrom(g.status),
    siteLastVisitAt: utc(g.last_visit),
    about: text(g.about),
    birthday: date(g.birthday),
    age: count(g.age),
    verified: g.is_verify === undefined || g.is_verify === null ? null : String(g.is_verify) === "1",
    likesCount: count(g.count_likes),
    favouritesCount: count(g.count_favourites),
    giftsCount: count(g.count_gifts),
  };
}

// A photo in her gallery (GET /gallery?user_id=…), as mirami sends it:
//   { id, type ("avatar" | "gallery"), is_premium, likes_count, create_time,
//     main_image: { url (428×428 crop), … }, original_image: { url, … },
//     name, description, is_liked, is_published }
// → { id, modelId, kind, premium, image, original, postedAt, likes }. A
// Premium-only photo comes with blurred pictures alone ("…/blur_…"): it's
// kept without them.
const BLURRED = /\/blur_[^/]+$/;
export function shapePhoto(p, modelId) {
  const premium = Boolean(Number(p.is_premium));
  const picture = (value) => {
    const url = text(value?.url);
    return premium || !url || BLURRED.test(url) ? null : url;
  };
  return {
    id: id(p.id),
    modelId,
    kind: text(p.type) ?? "gallery",
    premium,
    image: picture(p.main_image),
    original: picture(p.original_image),
    postedAt: utc(p.create_time),
    likes: count(p.likes_count),
  };
}

// A reel, with what her profile and mirami's girls lists say of her laid
// over what the reel says (they're fresher, and say more): the record the
// archive saves.
export function mergeGirl(reel, info, listed) {
  const pick = (...values) => values.find((v) => v !== null && v !== undefined) ?? null;
  return {
    ...reel,
    name: pick(info?.name, reel.name),
    avatar: pick(info?.avatar, reel.avatar),
    age: pick(info?.age, reel.age),
    online: pick(info?.online, reel.online),
    siteLastVisitAt: info?.siteLastVisitAt ?? null,
    about: info?.about ?? null,
    birthday: info?.birthday ?? null,
    verified: info?.verified ?? null,
    likesCount: pick(info?.likesCount, count(listed?.likes_count)),
    favouritesCount: pick(info?.favouritesCount, count(listed?.count_favourites)),
    giftsCount: info?.giftsCount ?? null,
    showsCount: count(listed?.shows_count),
  };
}
