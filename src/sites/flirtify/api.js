// flirtify's API and pages, read directly — no browser, no login: a guest
// sees everything the archive keeps. Two kinds of request:
//   json(path)  its API, https://flirtify.com/api/…
//   page(path)  the data behind one of its pages (SvelteKit's
//               __data.json), for what the API doesn't give a guest: a
//               model's profile, its category pages
// Counts the bytes it receives, for the run's "data consumed".

const SITE = "https://flirtify.com";
const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};
const TIMEOUT = 20000;

// SvelteKit sends a page's data flattened (the "devalue" format): one array
// of values, each object or array in it holding the indexes of its own.
// Index -1 is undefined and -2 null; a value like ["Date", "…"] is a special
// type, kept as its string.
export function unflatten(values) {
  const done = new Map();
  const at = (i) => {
    if (i === -1) return undefined;
    if (i < 0) return null;
    if (done.has(i)) return done.get(i);
    const v = values[i];
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") return v[1] ?? null;
      const list = [];
      done.set(i, list);
      for (const j of v) list.push(at(j));
      return list;
    }
    const object = {};
    done.set(i, object);
    for (const [key, j] of Object.entries(v)) object[key] = at(j);
    return object;
  };
  return at(0);
}

// A page's own data (its last node) from a __data.json answer: { data }, or
// { error } — e.g. { status: 404, message: "MODEL_NOT_FOUND" } — when the
// page has none.
export function pageData(json) {
  const node = json?.nodes?.at(-1);
  if (node?.type === "error") return { error: node.error ?? { message: "error" } };
  if (node?.type !== "data") return { error: { message: "no page data" } };
  return { data: unflatten(node.data) };
}

export function createApi() {
  let bytes = 0;

  async function get(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
    const raw = await res.text();
    bytes += raw.length;
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // Not JSON (an error page, say): `json` stays null.
    }
    return { status: res.status, ok: res.ok, json };
  }

  return {
    // GET /api/<path>: { status, ok, json } — json null when it isn't JSON.
    json: (path) => get(`${SITE}/api${path}`),
    // The data of the page at `path` (with its query, if any): { data } or
    // { error }, as pageData answers.
    async page(path) {
      const [route, query] = path.split("?");
      const params = new URLSearchParams(query);
      // Only the page's own data, not the layouts' around it.
      params.set("x-sveltekit-invalidated", "0001");
      const res = await get(`${SITE}${route.replace(/\/$/, "")}/__data.json?${params}`);
      if (!res.json) return { error: { status: res.status, message: `HTTP ${res.status}` } };
      return pageData(res.json);
    },
    megabytes: () => bytes / (1024 * 1024),
  };
}
