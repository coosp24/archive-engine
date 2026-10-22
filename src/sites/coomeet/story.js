// A story as coomeet's feed sends it, turned into what the archive keeps.
// coomeet sends:
//   { id, womanId, name, avatar: { s, m }, media: { webm, mp4, gif, preview },
//     publicationTime, online, balance, isLiked, isDisliked, contact }
// `mp4` is the video as MP4 and `gif` a small animated WebP of it (despite
// the name) — keys of their own, not the webm's with another extension;
// `balance` is the minutes a viewer needs to add her as a friend, which
// follows how popular she is; `online` is 1 while she's online. isLiked,
// isDisliked and contact are about whoever is viewing, not her.

// Where every key in a story is served from.
export const CDN = "https://n.coomeet.com/";

// A CDN key as its address; null for anything that isn't a plain key.
export const cdn = (key) => (typeof key === "string" && /^[\w.-]+$/.test(key) ? CDN + key : null);

// A smallint in the database; anything else (missing, "", a fraction) is
// left unknown rather than read as 0.
export function balanceOf(value) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= 32767 ? n : null;
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// coomeet sends some names HTML-escaped — "Hazel&lt;3" for what its pages
// show as "Hazel<3". Numeric escapes and the common named ones are decoded;
// anything else is left as it is.
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

// { id, name, avatar, published, storyId, src, preview, mp4, gif, balance,
//   online }: her id, the story's id, epoch-ms publication time, CDN
// addresses, and her online status — each null when the story doesn't say.
export function shapeStory(s) {
  const name = typeof s.name === "string" ? decodeEntities(s.name).trim() : "";
  return {
    id: s.womanId == null ? null : String(s.womanId),
    name: name || null,
    avatar: cdn(s.avatar?.m || s.avatar?.s),
    published: Number(s.publicationTime) > 0 ? Number(s.publicationTime) * 1000 : null,
    storyId: s.id == null ? null : String(s.id),
    src: cdn(s.media?.webm),
    preview: cdn(s.media?.preview),
    mp4: cdn(s.media?.mp4),
    gif: cdn(s.media?.gif),
    balance: balanceOf(s.balance),
    online: s.online == null ? null : Number(s.online) === 1,
  };
}
