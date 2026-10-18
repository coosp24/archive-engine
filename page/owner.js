// Runs in the page's own world (see manifest "world": "MAIN"). Finding whose
// story a piece of coomeet data is about.
//
// coomeet no longer puts the model id in the story's link, and the video's
// address is a random file name (n.coomeet.com/11-9a3a2caf-….webm). But the
// app still has to know whose story it's playing, so somewhere in the data it
// receives, that file name sits next to the owner's id. These helpers find it,
// without knowing coomeet's exact field names in advance.

(() => {
  const NOW = Date.now();

  // coomeet ids are the account's creation time in tenths of a millisecond —
  // 14 digits today. A candidate also has to decode to a plausible moment, so
  // an unrelated long number (a phone, a counter) isn't taken for one.
  const isModelId = (value) => {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^\d{13,15}$/.test(text)) return false;
    const ms = Number(text) / 10;
    return ms > Date.UTC(2014, 0, 1) && ms < NOW + 86_400_000;
  };

  // Keys that name a person rather than the story itself. A story object can
  // carry its own id in the same shape as a user's, so these are trusted over
  // a bare `id`. coomeet's own is `womanId` — a story in its feed reads
  // { name, media: { webm }, womanId: 16613919625017, id: 35047417 }.
  const OWNER_KEY =
    /^(woman|girl|performer|streamer|user|owner|author|model|creator|profile|account|sender|peer|from|uid)(_?id)?$/i;
  const OWNER_OBJECT =
    /^(woman|girl|performer|streamer|user|owner|author|model|creator|profile|account|sender|peer|from)$/i;
  // Failing those, any other `…Id` / `…_id` holding an id of the right shape.
  // Never a bare `id`: on a story, that's the story.
  const SOME_ID = /.(Id|_id|ID)$/;

  // The name shown beside the id, from the same object, when there is one.
  const nameIn = (obj) => {
    for (const key of ["name", "username", "nickname", "displayName", "title"]) {
      if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
    }
    return null;
  };

  // Her portrait's address, from the same object. coomeet gives it as a file
  // key — avatar: { s, m }, small and medium — on its CDN, which is also where
  // the scrapers save model images from: https://n.coomeet.com/<key>.
  const CDN = "https://n.coomeet.com/";
  const avatarIn = (obj) => {
    const avatar = obj.avatar;
    const key = typeof avatar === "string" ? avatar : (avatar?.m || avatar?.s || null);
    if (typeof key !== "string" || !key) return null;
    if (/^https:\/\/n\.coomeet\.com\//.test(key)) return key;
    return /^[\w.-]+$/.test(key) ? CDN + key : null;
  };

  // Who an object names, with whatever else it says about her.
  const owner = (id, obj) => ({ id: String(id), name: nameIn(obj), avatar: avatarIn(obj) });

  // The video's file name without its extension: the part that's the same in
  // every place the story is mentioned, whatever host or query is around it.
  const fileKey = (url) => {
    const match = /([\w-]{8,})\.(webm|mp4|m3u8|mov)\b/i.exec(String(url));
    return match ? match[1] : null;
  };

  // The owner named on one object: { id, name, avatar }, or null.
  const ownerIn = (obj) => {
    const entries = Object.entries(obj);
    for (const [key, value] of entries) {
      if (OWNER_KEY.test(key) && isModelId(value)) return owner(value, obj);
    }
    for (const [key, value] of entries) {
      if (OWNER_OBJECT.test(key) && value && typeof value === "object") {
        for (const inner of ["id", "uid", "userId", "user_id"]) {
          if (isModelId(value[inner])) {
            const her = owner(value[inner], value);
            return { ...her, name: her.name ?? nameIn(obj), avatar: her.avatar ?? avatarIn(obj) };
          }
        }
      }
    }
    for (const [key, value] of entries) {
      if (SOME_ID.test(key) && isModelId(value)) return owner(value, obj);
    }
    return null;
  };

  // Given the objects on the way down to a story's file name (nearest last),
  // the owner: an owner-ish field on the nearest object that has one; failing
  // that, the nearest *enclosing* object's plain `id` — the user a list of
  // stories hangs under — marked as a guess.
  const ownerFromPath = (path) => {
    for (let i = path.length - 1; i >= 0; i--) {
      const owner = ownerIn(path[i]);
      if (owner) return { ...owner, sure: true };
    }
    for (let i = path.length - 2; i >= 0; i--) {
      if (isModelId(path[i].id)) return { ...owner(path[i].id, path[i]), sure: false };
    }
    return null;
  };

  // Every story file name in `root`, with its owner. Bounded, and cycle-safe,
  // because it's also pointed at the app's live state, which links back on
  // itself everywhere.
  // The default budget fits a whole stories feed — around twenty values per
  // story, so a few thousand stories — while still stopping a walk through
  // the app's live state from running away.
  const storiesIn = (root, { maxNodes = 200_000, maxDepth = 12 } = {}) => {
    const found = new Map();
    const seen = new WeakSet();
    let nodes = 0;
    const walk = (value, path) => {
      if (nodes++ > maxNodes || path.length > maxDepth) return;
      if (typeof value === "string") {
        const key = fileKey(value);
        if (key && !found.has(key)) {
          const owner = ownerFromPath(path);
          if (owner) found.set(key, owner);
        }
        return;
      }
      if (!value || typeof value !== "object" || seen.has(value)) return;
      if (value instanceof Node || value === window) return;
      seen.add(value);
      path.push(value);
      try {
        for (const child of Array.isArray(value) ? value : Object.values(value)) {
          walk(child, path);
        }
      } catch {
        // A getter on live state threw; skip that branch.
      }
      path.pop();
    };
    walk(root, []);
    return found;
  };

  window.__cooscrap = { ...window.__cooscrap, isModelId, fileKey, storiesIn };
})();
