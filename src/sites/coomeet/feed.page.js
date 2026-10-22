// Runs in the page's own world, before coomeet's code (it's injected with
// evaluateOnNewDocument): talks to coomeet's server over the app's own
// logged-in websocket, so the stories feed can be read straight from it.
// It only carries data — what a story means is worked out in Node
// (./story.js).
//
// The app speaks JSON over that socket, sent as a Blob:
//   { event: { Cmd, Cid }, data }
// and the server answers each with { event: { Cmd: "Complete", Cid }, data }.
// The feed takes two commands:
//   StoryBatch { limit }        → data.stories: the next 20 at most
//   StoryLook  { id, storyId }  → marks a story viewed (id is hers)
// A batch keeps coming back the same until its stories are marked viewed,
// which is what moves the feed on.

(() => {
  const SOCKET = "wspr.coomeet.com";
  const LOOK_TIMEOUT = 10000;

  // Request ids of our own ("a1", "a2", …), so replies can't be mistaken for
  // the app's, which number theirs "1", "2", ….
  let lastCid = 0;
  const waiting = new Map();

  // The app's socket, kept as it's created — and again if the app
  // reconnects. It only takes requests once coomeet has sent it an
  // "Authorization" message: one sent before that is silently dropped.
  let socket = null;
  let authorized = false;
  // The close code of the app's socket, if coomeet has closed it.
  let closeCode = null;
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      if (!String(args[0]).includes(SOCKET)) return ws;
      socket = ws;
      authorized = false;
      closeCode = null;
      ws.addEventListener("close", (event) => {
        if (ws === socket) closeCode = event.code;
      });
      ws.addEventListener("message", async (event) => {
        let msg;
        try {
          const text = typeof event.data === "string" ? event.data : await event.data.text();
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg?.event?.Cmd === "Authorization" && ws === socket) authorized = true;
        waiting.get(msg?.event?.Cid)?.(msg);
      });
      return ws;
    },
  });

  // Sends one command and resolves with the server's reply, or with
  // { timeout: true } if none comes within `timeout`.
  const request = (cmd, data, timeout) =>
    new Promise((resolve) => {
      const cid = `a${++lastCid}`;
      const timer = setTimeout(() => finish({ timeout: true }), timeout);
      function finish(reply) {
        clearTimeout(timer);
        waiting.delete(cid);
        resolve(reply);
      }
      waiting.set(cid, finish);
      socket.send(new Blob([JSON.stringify({ event: { Cmd: cmd, Cid: cid }, data })]));
    });

  const ready = () => authorized && socket?.readyState === WebSocket.OPEN;

  // Why the connection isn't ready, for the log when it doesn't open in time.
  const socketStatus = () => {
    if (!socket) {
      return document.querySelector(".gender-item")
        ? "coomeet was still showing its gender screen"
        : "the app never opened its socket";
    }
    if (closeCode != null) return `coomeet closed the socket (code ${closeCode})`;
    if (socket.readyState === WebSocket.CONNECTING) return "the socket was still connecting";
    if (!authorized) return "the socket opened, but coomeet never authorized it";
    return "the socket is ready";
  };

  // Marks as viewed the batch before (`toLook`: { id, storyId } pairs) and
  // asks for the next one, in one go: the looks go out first, without
  // waiting for their replies — the socket keeps them in order, so the
  // server has them before the batch request. Answers { stories, lock } —
  // the stories as coomeet sent them — or { error, retry }, retry true when
  // asking again may well work (no answer, or the connection not ready yet).
  let lookTimeouts = 0;
  const nextBatch = async (toLook, timeout) => {
    if (!ready()) return { error: "coomeet's connection isn't ready", retry: true };
    for (const { id, storyId } of toLook) {
      request("StoryLook", { id: Number(id), storyId: Number(storyId) }, LOOK_TIMEOUT).then(
        (reply) => reply.timeout && lookTimeouts++,
      );
    }
    const reply = await request("StoryBatch", { limit: 20 }, timeout);
    if (reply.timeout) return { error: "coomeet didn't answer the batch request", retry: true };
    if (!Array.isArray(reply.data?.stories)) {
      return { error: `unexpected reply: ${JSON.stringify(reply).slice(0, 200)}` };
    }
    // `lock`: seconds left on the story limit coomeet's pages show a guest
    // (or an account without a subscription) — informational only: the
    // stories still come, just 5 a batch.
    return { stories: reply.data.stories, lock: Number(reply.data.storyLockExpirationTime) || 0 };
  };

  window.__cooscrap = {
    feedReady: ready,
    socketOpened: () => socket !== null,
    socketStatus,
    nextBatch,
    lookTimeouts: () => lookTimeouts,
  };
})();
