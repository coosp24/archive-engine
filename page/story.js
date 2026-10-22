// Runs in the page's own world, after owner.js and network.js (the same two
// files cooscrap-tool uses). Answers "which story is on screen, and whose is
// it?" for the archiver, which calls window.__cooscrap.currentStory().
//
// Two ways to the owner, in order — as in cooscrap-tool/src/page/story.js:
//   1. the network record (network.js): the owner that arrived with this
//      story's video file;
//   2. the app's own state: the story the player is showing — owner included
//      — is attached to the elements it rendered. Read from the <video> up.

(() => {
  const { ownerOf, storiesIn, fileKey } = window.__cooscrap;

  // The current slide and its video. Images and media are blocked, so the
  // video never plays — but its src is still set, which is all that's read.
  // Only the first story is the slider's first child: coomeet keeps a run of
  // slides and moves on through them, marking the one on screen as
  // data-name="current-story".
  const SLIDE =
    '#application-wrapper > div.coomeet-chat > div.stories > div.stories-viewer > div.stories-viewer__slider > div[data-name="current-story"]';
  const VIDEO = `${SLIDE} > div > video`;
  const NAME = `${SLIDE} > div > div.stories-ui > div.user-info > div.user-info__content > div.user-info__content--name > div.user-info__content--name__label`;
  // The slide's "next story" button, as in cooscrap-tool's story-keys.js.
  // It's coomeet's dislike button (data-name="story-dislike"), which moves on
  // to the next story; the site has no plain "next".
  const NEXT = ".storie-actions > div:nth-child(3) > div";

  // The framework state attached to an element and its ancestors.
  const stateAround = (el, limit = 25) => {
    const roots = [];
    const push = (value) => value && typeof value === "object" && roots.push(value);
    for (let node = el, depth = 0; node && depth < limit; node = node.parentElement, depth++) {
      for (const key of Object.keys(node)) {
        if (key === "__vueParentComponent") {
          for (let c = node[key], up = 0; c && up < 6; c = c.parent, up++) {
            push(c.props);
            push(c.setupState);
            push(c.data);
          }
        } else if (key === "__vue__") {
          for (let vm = node[key], up = 0; vm && up < 6; vm = vm.$parent, up++) {
            push(vm.$props);
            push(vm.$data);
          }
        } else if (key.startsWith("__reactProps$")) {
          push(node[key]);
        } else if (key.startsWith("__reactFiber$")) {
          for (let f = node[key], up = 0; f && up < 8; f = f.return, up++) {
            push(f.memoizedProps);
          }
        }
      }
      if (roots.length) break;
    }
    return roots;
  };

  const fromState = (video, key) => {
    if (!key) return null;
    for (const value of stateAround(video)) {
      const owner = storiesIn(value).get(key);
      if (owner) return owner;
    }
    return null;
  };

  // { src, id, name, avatar, published, storyId, preview } for the story on
  // screen; all but src are null while they're unknown. `published` is epoch
  // ms, from the story's data — the screen only says "today" or
  // "yesterday". `avatar` is her profile picture, `storyId` coomeet's id for
  // the story and `preview` its still image, all from the same data.
  const currentStory = () => {
    const video = document.querySelector(VIDEO);
    const src = video?.currentSrc || video?.src || null;
    const owner = src ? (ownerOf(src) ?? fromState(video, fileKey(src))) : null;
    return {
      src,
      id: owner?.id ?? null,
      name: src ? document.querySelector(NAME)?.textContent.trim() || null : null,
      avatar: owner?.avatar ?? null,
      published: owner?.published ?? null,
      storyId: owner?.storyId ?? null,
      preview: owner?.preview ?? null,
    };
  };

  // A full press — pointer and mouse down and up, then click — since some of
  // coomeet's controls never see a bare click() (cooscrap-tool's press.js).
  const press = (el) => {
    const at = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: at.left + at.width / 2,
      clientY: at.top + at.height / 2,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", init));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  };

  // Presses the current slide's next button. False when there isn't one.
  const nextStory = () => {
    const button = document.querySelector(`${SLIDE} ${NEXT}`);
    if (!button) return false;
    press(button);
    return true;
  };

  // coomeet only shows a guest a handful of stories (10 in testing), then
  // swaps the viewer for "No new videos yet" — with "Want more? … or wait
  // 04:08" under it while a countdown runs. What it says, on one line, once
  // that's on screen; else null. The placeholder is always in the page,
  // under the slides, so it only counts once no story is showing over it.
  const PLACEHOLDER = ".stories-viewer .stories-placeholder";
  const limitMessage = () => {
    if (currentStory().src) return null;
    const el = document.querySelector(PLACEHOLDER);
    if (!el || !el.getBoundingClientRect().width) return null;
    return el.innerText.replace(/\s+/g, " ").trim() || "No new videos yet";
  };

  // Resolves with the story on screen once its src isn't `prev` and her id is
  // known — or `ownerTimeout` ms after it appeared, without her id; null if
  // no new story shows up within `timeout`. Done in the page rather than by
  // polling from outside, so the run hears of the next story the moment it's
  // there: on every change to a video's src or the current slide, and every
  // 25ms for her id, which comes over the network rather than in the DOM.
  const waitForStory = (prev, timeout, ownerTimeout) =>
    new Promise((resolve) => {
      let appearedAt = null;
      let finished = false;
      const done = (story) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(timer);
        resolve(story);
      };
      const check = () => {
        const story = currentStory();
        if (!story.src || story.src === prev) return;
        appearedAt ??= Date.now();
        if (story.id || Date.now() - appearedAt >= ownerTimeout) done(story);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-name"],
      });
      const interval = setInterval(check, 25);
      const timer = setTimeout(() => done(appearedAt ? currentStory() : null), timeout);
      check();
    });

  // Presses "next" and waits for the story it brings up, in one call:
  // { pressed: false } when there's no next button, else { pressed: true,
  // story } with story as from waitForStory.
  const advance = async (prev, timeout, ownerTimeout) => {
    if (!nextStory()) return { pressed: false, story: null };
    return { pressed: true, story: await waitForStory(prev, timeout, ownerTimeout) };
  };

  window.__cooscrap = {
    ...window.__cooscrap,
    currentStory,
    nextStory,
    limitMessage,
    waitForStory,
    advance,
  };
})();
