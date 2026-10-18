// Runs in the page's own world, before coomeet's code, so it can listen to
// everything the app downloads: fetch, XHR and WebSocket messages. Each
// payload that mentions a video is searched for story files and their owners,
// and remembered — so when a story starts playing, its owner is already known.
//
// Nothing is changed or blocked: every original call goes through untouched,
// and the reading happens on copies, after the app has its data.

(() => {
  const { storiesIn, fileKey, isModelId } = window.__cooscrap;

  // File name → { id, sure, via }.
  const owners = new Map();
  // The last few payloads that mentioned a video, for "Copy diagnostics".
  const recent = [];
  const RECENT_LIMIT = 40;
  const EXCERPT = 4000;

  const MENTIONS_VIDEO = /\.(webm|mp4|m3u8|mov)\b/i;

  // Payloads that aren't JSON still get a look: the nearest model-id-shaped
  // number to each file name, always marked as a guess.
  const fromText = (text) => {
    const found = new Map();
    const files = /([\w-]{8,})\.(webm|mp4|m3u8|mov)\b/gi;
    for (const match of text.matchAll(files)) {
      const around = text.slice(Math.max(0, match.index - 400), match.index + 400);
      const id = [...around.matchAll(/\d{13,15}/g)].map((m) => m[0]).find(isModelId);
      if (id && !found.has(match[1])) found.set(match[1], { id, sure: false });
    }
    return found;
  };

  // Everything heard, video or not — so diagnostics can show whether the page
  // is talking over fetch, XHR or a socket at all, and what it's saying.
  const heard = [];
  const HEARD_LIMIT = 60;

  const take = (text, via) => {
    if (typeof text !== "string") return;
    heard.push({
      via,
      bytes: text.length,
      video: MENTIONS_VIDEO.test(text),
      start: text.slice(0, 300),
    });
    if (heard.length > HEARD_LIMIT) heard.shift();
    if (!MENTIONS_VIDEO.test(text)) return;
    recent.push({ via, at: Date.now(), text: text.length > 200_000 ? text.slice(0, 200_000) : text });
    if (recent.length > RECENT_LIMIT) recent.shift();

    let found;
    try {
      found = storiesIn(JSON.parse(text));
    } catch {
      found = fromText(text);
    }
    for (const [key, owner] of found) {
      // A sure answer is never overwritten by a guess.
      const known = owners.get(key);
      if (known?.sure && !owner.sure) continue;
      owners.set(key, { ...owner, via });
    }
  };

  const decode = async (data) => {
    if (typeof data === "string") return data;
    try {
      if (data instanceof Blob) return await data.text();
      if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
      if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    } catch {}
    return null;
  };

  // --- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const type = response.headers.get("content-type") ?? "";
      if (/json|text|javascript/.test(type)) {
        response.clone().text().then((text) => take(text, `fetch ${response.url}`), () => {});
      }
    } catch {}
    return response;
  };

  // --- XHR -----------------------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType === "" || this.responseType === "text") {
          take(this.responseText, `xhr ${url}`);
        } else if (this.responseType === "json" && this.response) {
          take(JSON.stringify(this.response), `xhr ${url}`);
        }
      } catch {}
    });
    return nativeOpen.call(this, method, url, ...rest);
  };

  // --- WebSocket -----------------------------------------------------------
  // A subclass rather than a patch on the prototype, so every socket the app
  // opens — however it attaches its own listeners — is heard from the start.
  const NativeWebSocket = window.WebSocket;
  class ListeningWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        decode(event.data).then((text) => text && take(text, `ws ${this.url}`));
      });
    }
  }
  window.WebSocket = ListeningWebSocket;

  const ownerOf = (src) => {
    const key = fileKey(src);
    return key ? (owners.get(key) ?? null) : null;
  };

  // The recent payloads that mention this story's file, trimmed to the part
  // around it — what "Copy diagnostics" hands over.
  const excerptsFor = (src) => {
    const key = fileKey(src);
    if (!key) return [];
    return recent
      .filter((r) => r.text.includes(key))
      .map((r) => {
        const at = r.text.indexOf(key);
        return {
          via: r.via,
          excerpt: r.text.slice(Math.max(0, at - EXCERPT / 2), at + EXCERPT / 2),
        };
      });
  };

  window.__cooscrap = {
    ...window.__cooscrap,
    ownerOf,
    excerptsFor,
    knownStories: () => owners.size,
    knownStoryKeys: () => [...owners.entries()].slice(-20),
    heardLately: () => heard.slice(-30),
  };
})();
