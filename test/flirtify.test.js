import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageData, unflatten } from "../src/sites/flirtify/api.js";
import {
  mediaKey,
  mergeModel,
  shapeListed,
  shapeOperator,
  shapeProfile,
  shapeStory,
} from "../src/sites/flirtify/model.js";

// A model as flirtify sends her with a story (ids and signatures made up).
const OPERATOR = {
  id: "671784fd7b97c079a956beb5",
  displayName: " Shane ",
  username: "shane_14",
  canCall: true,
  isOnline: true,
  intId: 4061428,
  avatar: "https://avatar.flirtify.com/AbC-d_e1==,1792980146/avatar/6/7/1/7/671784fd7b97c079a956beb5/1-avatar.jpg",
  status: "active",
  earningsTotalCents: 0,
  isLive: false,
  isVip: false,
  callPriceInSec: 60,
};

const DIR = "https://lumen.flirtify.com/24quQFHOOynvQPab-w==,1792980146/6/a/b/5/6ab5cf4dd5d35eb4cd0b0449";
const STORY = {
  id: "6ab5cf4dd5d35eb4cd0b0449",
  intId: 225317,
  slug: "shane_14-225317",
  operator: OPERATOR,
  previewImgUrl: `${DIR}/poster.webp`,
  feedImgUrl: `${DIR}/feed_poster.webp`,
  videoUrl: `${DIR}/1080p.h264.mp4`,
  orientation: "vertical",
  statusUpdatedAt: "2026-09-25T01:33:54.438Z",
};

describe("flirtify mediaKey", () => {
  it("drops a link's signature, so the same picture keeps the same key", () => {
    assert.equal(
      mediaKey(OPERATOR.avatar),
      "https://avatar.flirtify.com/avatar/6/7/1/7/671784fd7b97c079a956beb5/1-avatar.jpg",
    );
    assert.equal(
      mediaKey("https://avatar.flirtify.com/Zz9==,1792999999/avatar/6/7/1/7/671784fd7b97c079a956beb5/1-avatar.jpg"),
      mediaKey(OPERATOR.avatar),
    );
  });

  it("leaves a link without a signature as it is", () => {
    assert.equal(mediaKey("https://example.com/a/b.jpg"), "https://example.com/a/b.jpg");
    assert.equal(mediaKey(null), null);
  });
});

describe("flirtify shapeOperator", () => {
  it("keeps who she is, and whether she's online", () => {
    assert.deepEqual(shapeOperator(OPERATOR), {
      modelId: "671784fd7b97c079a956beb5",
      intId: 4061428,
      username: "shane_14",
      name: "Shane",
      avatar: OPERATOR.avatar,
      avatarKey: "https://avatar.flirtify.com/avatar/6/7/1/7/671784fd7b97c079a956beb5/1-avatar.jpg",
      online: true,
    });
  });

  it("has no id for anything but 24 hex digits, and no avatar for none", () => {
    const shaped = shapeOperator({ ...OPERATOR, id: "nope", avatar: null, isOnline: undefined });
    assert.equal(shaped.modelId, null);
    assert.equal(shaped.avatar, null);
    assert.equal(shaped.avatarKey, null);
    assert.equal(shaped.online, null);
  });

  it("counts streaming as online", () => {
    assert.equal(shapeOperator({ ...OPERATOR, isOnline: false, isLive: true }).online, true);
  });
});

describe("flirtify shapeStory", () => {
  it("keeps its number as its id, and the small still image", () => {
    assert.deepEqual(shapeStory(STORY), {
      storyId: "225317",
      uid: "6ab5cf4dd5d35eb4cd0b0449",
      slug: "shane_14-225317",
      src: `${DIR}/1080p.h264.mp4`,
      preview: `${DIR}/feed_poster.webp`,
      published: "2026-09-25T01:33:54.438Z",
      orientation: "vertical",
    });
  });

  it("works the small still image out from the poster when it's the only one sent", () => {
    // Her profile sends the poster as both.
    const story = { ...STORY, feedImgUrl: `${DIR}/poster.webp`, publishedAt: "2026-09-25T01:00:00.000Z" };
    assert.equal(shapeStory(story).preview, `${DIR}/feed_poster.webp`);
    assert.equal(shapeStory(story).published, "2026-09-25T01:00:00.000Z");
    // An older story's are JPEGs.
    const older = { ...STORY, previewImgUrl: `${DIR}/poster.jpg`, feedImgUrl: `${DIR}/poster.jpg` };
    assert.equal(shapeStory(older).preview, `${DIR}/feed_poster.jpg`);
  });
});

describe("flirtify shapeProfile and shapeListed", () => {
  it("adds what her profile says", () => {
    const profile = shapeProfile({
      ...OPERATOR,
      callPriceInSec: 120,
      description: " hi ",
      spokenLanguages: ["en", "es"],
      access: "available",
      stories: [STORY],
      hasMoreStories: false,
    });
    assert.equal(profile.about, "hi");
    assert.deepEqual(profile.languages, ["en", "es"]);
    assert.equal(profile.callPrice, 120);
    assert.equal(profile.access, "available");
    assert.equal(profile.stories.length, 1);
    assert.equal(profile.moreStories, false);
  });

  it("keeps a category page's country, upper case", () => {
    const listed = shapeListed({ ...OPERATOR, country: "co", spokenLanguages: [] });
    assert.equal(listed.country, "CO");
    assert.equal(listed.languages, null);
  });
});

describe("flirtify mergeModel", () => {
  const feed = shapeOperator(OPERATOR);
  const story = shapeStory(STORY);

  it("lays her profile and category over the feed, and keeps every story once", () => {
    const older = { ...STORY, id: "6aa000000000000000000000", intId: 100, slug: "shane_14-100" };
    const record = mergeModel({
      feed,
      story,
      listed: shapeListed({ ...OPERATOR, displayName: "Shane L", country: "CO", spokenLanguages: ["es"] }),
      profile: shapeProfile({ ...OPERATOR, displayName: "Shane P", isOnline: false, stories: [STORY, older] }),
      ageGroup: 20,
    });
    assert.equal(record.name, "Shane P");
    assert.equal(record.online, false);
    assert.equal(record.country, "CO");
    assert.equal(record.ageGroup, 20);
    assert.deepEqual(record.languages, ["es"]);
    assert.deepEqual(record.stories.map((s) => s.storyId), ["225317", "100"]);
  });

  it("keeps the feed's story when there's no profile, and marks her online while she streams", () => {
    const record = mergeModel({ feed: { ...feed, online: false }, story, live: true });
    assert.equal(record.online, true);
    assert.deepEqual(record.stories, [story]);
    assert.equal(record.about, null);
    assert.equal(record.country, null);
  });
});

describe("flirtify page data", () => {
  it("unflattens SvelteKit's data", () => {
    // { profile: { name: "A", tags: ["x", "x"], none: null }, at: Date }
    const values = [{ profile: 1, at: 6 }, { name: 2, tags: 3, none: -2 }, "A", [4, 4], "x", null, ["Date", "2026-10-24T00:00:00.000Z"]];
    assert.deepEqual(unflatten(values), {
      profile: { name: "A", tags: ["x", "x"], none: null },
      at: "2026-10-24T00:00:00.000Z",
    });
  });

  it("answers the page's own node, or its error", () => {
    const ok = { type: "data", nodes: [{ type: "skip" }, { type: "data", data: [{ a: 1 }, 7] }] };
    assert.deepEqual(pageData(ok), { data: { a: 7 } });
    const missing = { type: "data", nodes: [{ type: "skip" }, { type: "error", error: { status: 404, message: "MODEL_NOT_FOUND" } }] };
    assert.deepEqual(pageData(missing), { error: { status: 404, message: "MODEL_NOT_FOUND" } });
  });
});
