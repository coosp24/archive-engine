// mirami's API (https://mirame.chat/api — "mirame", with an e), spoken
// directly — no browser. A guest token comes from its socket.io server
// (the same as the page's first message there), and goes with every call
// as a Chat-Token header. Counts the bytes it receives, for the run's "data
// consumed".
//
// The engine reads mirami as a guest: a logged-in account was tried and
// saw nothing more (and a few reels fewer).

const API = "https://mirame.chat/api";
const SOCKET = "wss://mirame.chat/socket.io/?EIO=4&transport=websocket";
const ORIGIN = "https://mirami.chat";
const HEADERS = { Accept: "application/json", Origin: ORIGIN, Referer: `${ORIGIN}/`, "Client-Version": "2.0.0" };
// What the page itself sends to sign in as a guest.
const AUTH = { ref_code: "mirami.chat", signature: "01f312c", device_type: "web", version: "2.0.1", timezone: "UTC" };
const TIMEOUT = 20000;

// A guest token: socket.io's handshake ("0" → "40" → "40{…}"), then the
// AUTH message, answered by a "notice" carrying the token. Pings ("2") are
// answered ("3") meanwhile.
export function guestToken() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SOCKET, { headers: { Origin: ORIGIN } });
    const done = (error, token) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(token);
    };
    const timer = setTimeout(() => done(new Error("mirami gave no guest token in time")), TIMEOUT);
    ws.onerror = () => done(new Error("Couldn't reach mirami's socket"));
    ws.onmessage = ({ data }) => {
      const message = String(data);
      if (message.startsWith("0")) ws.send("40");
      else if (message.startsWith("40")) ws.send(`42${JSON.stringify(["message_main", { action: "AUTH", data: AUTH }])}`);
      else if (message === "2") ws.send("3");
      else if (message.startsWith("42")) {
        const [event, payload] = JSON.parse(message.slice(2));
        if (event === "notice" && payload?.data?.token) done(null, payload.data.token);
      }
    };
  });
}

export function createApi() {
  let token = null;
  let bytes = 0;

  return {
    async signIn() {
      token = await guestToken();
    },
    // GET `path`: { status, ok, json } — json null when it isn't JSON.
    async get(path) {
      const res = await fetch(`${API}${path}`, {
        headers: { ...HEADERS, "Chat-Token": token },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const raw = await res.text();
      bytes += raw.length;
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        // Not JSON (an empty 404, say): `json` stays null.
      }
      return { status: res.status, ok: res.ok, json };
    },
    megabytes: () => bytes / (1024 * 1024),
  };
}
