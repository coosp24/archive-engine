import { createHttp } from "../../core/http.js";

// flirtbees' API (https://api.flirtbees.com/api/v1), spoken directly — no
// browser: a token from logging in (or a guest one), sent as a Bearer
// header with every call.

const API = "https://api.flirtbees.com/api/v1";
const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://flirtbees.com",
  Referer: "https://flirtbees.com/",
};
const TIMEOUT = 20000;

export function createApi() {
  const http = createHttp({ headers: HEADERS, timeout: TIMEOUT });
  let token = null;

  const call = (method, path, body) =>
    http.request(`${API}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body,
    });

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
    megabytes: http.megabytes,
  };
}
