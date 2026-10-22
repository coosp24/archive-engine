// A story as flirtbees' API sends it (GET /stories/public), turned into what
// the archive keeps. flirtbees sends:
//   { id, uid, url (webm), url_mp4, thumbnail, published_at, likes, points,
//     duration, comments_count, status, is_liked, relationship,
//     user: { id, uid, name, avatar, avatar_original, online, last_online_at } }
// The archive leaves out duration, comments_count (always 0), status
// (always "Approved"), and is_liked and relationship, which are about
// whoever is viewing, not her.

// What flirtbees shows a model without a picture of her own.
const PLACEHOLDER_AVATAR = /\/avatars\/avatar(-sm)?\.\w+$/;

// Her avatar's full size: flirtbees sends a small one ("…/<key>-sm.jpg",
// 3–7 KB) and keeps the full one beside it without "-sm" — as a .jpg or,
// sometimes, a .png. The addresses to try, in that order; none for the
// placeholder, which is no avatar of hers.
export function fullAvatarCandidates(small) {
  if (typeof small !== "string" || !small || PLACEHOLDER_AVATAR.test(small)) return [];
  const base = small.replace(/-sm\.\w+$/, "");
  if (base === small) return [small];
  return [`${base}.jpg`, `${base}.png`];
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const time = (value) => (value && !Number.isNaN(Date.parse(value)) ? value : null);

// { modelId, modelUid, name, avatarSmall, online, siteLastOnlineAt,
//   storyId, storyUid, src, mp4, preview, published, likes, points } — each
//   null when the story doesn't say. `published` and `siteLastOnlineAt` are
//   ISO times; `avatarSmall` is the small avatar as sent (see
//   fullAvatarCandidates for the one kept).
export function shapeStory(s) {
  const user = s.user ?? {};
  return {
    modelId: text(user.id),
    modelUid: text(user.uid),
    name: text(user.name),
    avatarSmall: text(user.avatar),
    online: typeof user.online === "boolean" ? user.online : null,
    siteLastOnlineAt: time(user.last_online_at),
    storyId: s.id == null ? null : String(s.id),
    storyUid: text(s.uid),
    src: text(s.url),
    mp4: text(s.url_mp4),
    preview: text(s.thumbnail),
    published: time(s.published_at),
    likes: count(s.likes),
    points: count(s.points),
  };
}
