import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fullAvatarCandidates, shapeStory } from "../src/sites/flirtbees/story.js";

// A story as flirtbees' API sends it (ids and keys made up).
const RAW = {
  id: "39842",
  uid: "6ad955871c6c1",
  url: "https://assets.flirtbees.com/stories/abc-1.webm",
  url_mp4: "https://assets.flirtbees.com/stories/abc-1.mp4",
  thumbnail: "https://assets.flirtbees.com/stories/abc-2.jpg",
  user: {
    name: " Emily ",
    avatar: "https://assets.flirtbees.com/avatars/KEY-sm.jpg",
    avatar_original: null,
    uid: "e961804118e3f565343d57b95b96e0d1",
    id: "691f9e7d013d09eaa4014155",
    online: false,
    last_online_at: "2026-10-22T00:39:21.603000Z",
  },
  status: "Approved",
  duration: 8,
  published_at: "2026-10-22T00:15:13.000000Z",
  relationship: null,
  is_liked: false,
  points: 6,
  likes: 28,
  comments_count: 0,
};

describe("flirtbees shapeStory", () => {
  it("keeps what the archive stores, and leaves the rest out", () => {
    assert.deepEqual(shapeStory(RAW), {
      modelId: "691f9e7d013d09eaa4014155",
      modelUid: "e961804118e3f565343d57b95b96e0d1",
      name: "Emily",
      avatarSmall: "https://assets.flirtbees.com/avatars/KEY-sm.jpg",
      online: false,
      siteLastOnlineAt: "2026-10-22T00:39:21.603000Z",
      storyId: "39842",
      storyUid: "6ad955871c6c1",
      src: "https://assets.flirtbees.com/stories/abc-1.webm",
      mp4: "https://assets.flirtbees.com/stories/abc-1.mp4",
      preview: "https://assets.flirtbees.com/stories/abc-2.jpg",
      published: "2026-10-22T00:15:13.000000Z",
      likes: 28,
      points: 6,
    });
  });

  it("leaves what the story doesn't say as null", () => {
    const story = shapeStory({ id: 1, user: { online: "yes", last_online_at: "not a date" }, likes: -1, points: 1.5 });
    assert.equal(story.storyId, "1");
    assert.equal(story.modelId, null);
    assert.equal(story.online, null);
    assert.equal(story.siteLastOnlineAt, null);
    assert.equal(story.likes, null);
    assert.equal(story.points, null);
  });
});

describe("fullAvatarCandidates", () => {
  it("drops -sm, trying .jpg then .png", () => {
    assert.deepEqual(fullAvatarCandidates("https://assets.flirtbees.com/avatars/KEY-sm.jpg"), [
      "https://assets.flirtbees.com/avatars/KEY.jpg",
      "https://assets.flirtbees.com/avatars/KEY.png",
    ]);
  });

  it("has none for flirtbees' placeholder, or no avatar", () => {
    assert.deepEqual(fullAvatarCandidates("https://assets.flirtbees.com/avatars/avatar-sm.jpg"), []);
    assert.deepEqual(fullAvatarCandidates(null), []);
  });

  it("takes an avatar that isn't a small one as it is", () => {
    const url = "https://assets.flirtbees.com/avatars/KEY.png";
    assert.deepEqual(fullAvatarCandidates(url), [url]);
  });
});
