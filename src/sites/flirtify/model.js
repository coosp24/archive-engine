// flirtify's models and stories as it sends them, turned into what the
// archive keeps. Each comes with the model ("operator") it's about:
//   { id (24 hex), intId, username, displayName, avatar, isOnline, canCall,
//     status, callPriceInSec, isLive, isVip, earningsTotalCents, … }
// A story (GET /api/story/feed, and her profile's list):
//   { id (24 hex), intId, slug, operator, previewImgUrl, feedImgUrl,
//     videoUrl, orientation, statusUpdatedAt, publishedAt (profile only) }
// Her profile (/profile/<username>): the operator, and description,
//   spokenLanguages, access, stories, hasMoreStories, …
// A category page's model (/categories/<slug>): the operator, and country,
//   spokenLanguages, story.
//
// Left out: canCall (the same as isOnline), status (always "active"),
// isVip, earningsTotalCents and haveTransactionLastYear (always false or 0
// to a guest), the feed's callPriceInSec (always 60 there; her profile
// gives her own), and the is…Blocked and inFavoriteList flags, which are
// about whoever is viewing.

// flirtify's picture and video links are signed: "https://<host>/<token>==,
// <expiry>/<path>", and stop working at <expiry>, about two days on. Without
// that part, the same picture always has the same link: what tells avatars
// apart.
const SIGNATURE = /^(https:\/\/[^/]+)\/[\w-]+=*,\d+\//;
export const mediaKey = (url) => (typeof url === "string" ? url.replace(SIGNATURE, "$1/") : null);

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const time = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);
const ID = /^[0-9a-f]{24}$/;
const languages = (value) => {
  const list = Array.isArray(value) ? value.map(text).filter(Boolean) : [];
  return list.length ? list : null;
};

// A story's still image: flirtify's small one ("feed_poster.webp", or .jpg
// for older stories, ~10 KB) rather than its full-size poster (~100–575
// KB) — they sit side by side, under the same signature.
export function storyPreview(s) {
  const feed = text(s.feedImgUrl);
  if (feed && feed !== text(s.previewImgUrl)) return feed;
  const poster = text(s.previewImgUrl);
  return poster ? poster.replace(/\/poster\.(webp|jpg)(\?|$)/, "/feed_poster.$1$2") : feed;
}

// { modelId, intId, username, name, avatar, avatarKey, online } — each null
// when flirtify doesn't say.
export function shapeOperator(o = {}) {
  const id = text(o.id);
  const avatar = text(o.avatar);
  return {
    modelId: id && ID.test(id) ? id : null,
    intId: count(o.intId),
    username: text(o.username),
    name: text(o.displayName),
    avatar,
    avatarKey: avatar && mediaKey(avatar),
    online: typeof o.isOnline === "boolean" ? o.isOnline || o.isLive === true : null,
  };
}

// { storyId, uid, slug, src, preview, published, orientation } — storyId
// is flirtify's number for it (intId), as a string; null when it doesn't
// say.
export function shapeStory(s = {}) {
  return {
    storyId: count(s.intId) === null ? null : String(s.intId),
    uid: text(s.id),
    slug: text(s.slug),
    src: text(s.videoUrl),
    preview: storyPreview(s),
    published: time(s.publishedAt) ?? time(s.statusUpdatedAt),
    orientation: text(s.orientation),
  };
}

// What her profile adds: { about, languages, callPrice, access, stories,
// moreStories } — and the operator fields, fresher than the feed's.
export function shapeProfile(p = {}) {
  return {
    ...shapeOperator(p),
    about: text(p.description),
    languages: languages(p.spokenLanguages ?? p.languages),
    callPrice: count(p.callPriceInSec),
    access: text(p.access),
    stories: (Array.isArray(p.stories) ? p.stories : []).map(shapeStory),
    moreStories: p.hasMoreStories === true,
  };
}

// A model on a category page: { …operator, country, languages }.
export function shapeListed(m = {}) {
  return {
    ...shapeOperator(m),
    country: text(m.country)?.toUpperCase() ?? null,
    languages: languages(m.spokenLanguages),
  };
}

// One model's record, as the archive saves it: what the feed, her category
// pages, the live streams and her profile said of her, the freshest over
// the rest — her profile, then the category pages, then the feed. Her
// stories: the profile's, and the feed's (her newest) if it isn't among
// them. `ageGroup` is her category bracket (18, 20, 30, 40, 50), `live`
// whether she was streaming.
export function mergeModel({ feed = null, story = null, listed = null, profile = null, ageGroup = null, live = false }) {
  const pick = (...values) => values.find((v) => v !== null && v !== undefined) ?? null;
  const sources = [profile, listed, feed].filter(Boolean);
  const field = (name) => pick(...sources.map((s) => s[name]));
  const avatar = field("avatar");
  const stories = [...(profile?.stories ?? [])];
  if (story && !stories.some((s) => s.storyId === story.storyId)) stories.push(story);
  const online = field("online");
  return {
    modelId: field("modelId"),
    intId: field("intId"),
    username: field("username"),
    name: field("name"),
    avatar,
    avatarKey: avatar && mediaKey(avatar),
    online: live ? true : online,
    country: listed?.country ?? null,
    ageGroup,
    about: profile?.about ?? null,
    languages: pick(profile?.languages, listed?.languages),
    callPrice: profile?.callPrice ?? null,
    access: profile?.access ?? null,
    stories: stories.filter((s) => s.storyId && s.uid && s.src),
  };
}
