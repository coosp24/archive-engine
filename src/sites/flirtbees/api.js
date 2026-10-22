// flirtbees' API (https://api.flirtbees.com/api/v1), spoken directly — no
// browser: a token from logging in (or a guest one), sent as a Bearer
// header with every call. Counts the bytes it receives, for the run's
// "data consumed".

const API = "https://api.flirtbees.com/api/v1";
const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://flirtbees.com",
  Referer: "https://flirtbees.com/",
};
const TIMEOUT = 20000;

export function createApi() {
  let token = null;
  let bytes = 0;

  async function call(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
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
    // Logs in with { email, password }, else (no account, or a login that
    // fails) gets a guest token. Answers whether it's logged in.
    async signIn(account) {
      if (account) {
        const res = await call("POST", "/login", {
          username: account.email,
          password: account.password,
          device: "web",
        });
        if (res.json?.data?.token) {
          token = res.json.data.token;
          return true;
        }
        console.warn(`⚠️ flirtbees login failed (HTTP ${res.status}: ${res.json?.message ?? "no message"}) — going on as a guest`);
      }
      const res = await call("POST", "/guest", {});
      if (!res.json?.data?.token) throw new Error(`flirtbees gave no guest token (HTTP ${res.status})`);
      token = res.json.data.token;
      return false;
    },
    get: (path) => call("GET", path),
    // Whether `url` answers (for an asset on flirtbees' CDN).
    async exists(url) {
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT) });
        return res.ok;
      } catch {
        return false;
      }
    },
    megabytes: () => bytes / (1024 * 1024),
  };
}
