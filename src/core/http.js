// Requests for a site read without a browser (talking to its API
// directly): each with a time limit, its answer read as JSON where it is,
// and the bytes received counted, for the run's "data consumed" — which a
// browser would count itself (./browser.js).

const TIMEOUT = 20000;

// `headers` go with every request. Answers { request, megabytes }.
export function createHttp({ headers = {}, timeout = TIMEOUT } = {}) {
  let bytes = 0;

  return {
    // `url`, with `options` ({ method, headers, body }; a body is sent as
    // JSON): { status, ok, json } — json null when the answer isn't JSON (an
    // error page, an empty 404).
    async request(url, { method = "GET", headers: extra, body } = {}) {
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const raw = await res.text();
      bytes += raw.length;
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        // Not JSON: `json` stays null.
      }
      return { status: res.status, ok: res.ok, json };
    },
    megabytes: () => bytes / (1024 * 1024),
  };
}
