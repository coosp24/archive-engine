import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { balanceOf, cdn, decodeEntities, shapeStory } from "../src/sites/coomeet/story.js";

// A story as coomeet's feed sends it (ids and keys made up).
const RAW = {
  id: 35047417,
  womanId: 17733519225312,
  name: "Hazel&lt;3 &amp; co",
  avatar: { s: "11-aaaaaaaa-small", m: "11-aaaaaaaa-medium" },
  media: {
    webm: "11-bbbbbbbb.webm",
    mp4: "11-cccccccc",
    gif: "11-dddddddd",
    preview: "11-eeeeeeee",
  },
  publicationTime: 1761100000,
  online: 1,
  balance: 60,
  isLiked: false,
  contact: { Status: 0 },
};

describe("shapeStory", () => {
  it("keeps what the archive stores, as addresses on coomeet's CDN", () => {
    assert.deepEqual(shapeStory(RAW), {
      id: "17733519225312",
      name: "Hazel<3 & co",
      avatar: "https://n.coomeet.com/11-aaaaaaaa-medium",
      published: 1761100000000,
      storyId: "35047417",
      src: "https://n.coomeet.com/11-bbbbbbbb.webm",
      preview: "https://n.coomeet.com/11-eeeeeeee",
      mp4: "https://n.coomeet.com/11-cccccccc",
      gif: "https://n.coomeet.com/11-dddddddd",
      balance: 60,
      online: true,
    });
  });

  it("falls back to the small avatar, and says offline", () => {
    const story = shapeStory({ ...RAW, avatar: { s: "11-small" }, online: 0 });
    assert.equal(story.avatar, "https://n.coomeet.com/11-small");
    assert.equal(story.online, false);
  });

  it("leaves what the story doesn't say as null", () => {
    assert.deepEqual(shapeStory({}), {
      id: null,
      name: null,
      avatar: null,
      published: null,
      storyId: null,
      src: null,
      preview: null,
      mp4: null,
      gif: null,
      balance: null,
      online: null,
    });
  });

  it("treats a blank name as no name", () => {
    assert.equal(shapeStory({ ...RAW, name: "   " }).name, null);
  });
});

describe("cdn", () => {
  it("only takes plain keys", () => {
    assert.equal(cdn("11-abc.webm"), "https://n.coomeet.com/11-abc.webm");
    assert.equal(cdn("https://evil.example/x"), null);
    assert.equal(cdn("../x"), null);
    assert.equal(cdn(42), null);
  });
});

describe("balanceOf", () => {
  it("reads whole numbers in a smallint's range", () => {
    assert.equal(balanceOf(60), 60);
    assert.equal(balanceOf("46"), 46);
    assert.equal(balanceOf(0), 0);
  });

  it("leaves anything else unknown rather than 0", () => {
    for (const value of [undefined, null, "", " ", "abc", 1.5, -1, 40000]) {
      assert.equal(balanceOf(value), null, String(value));
    }
  });
});

describe("decodeEntities", () => {
  it("decodes the common named escapes and numeric ones", () => {
    assert.equal(decodeEntities("a &lt;3 &gt; &quot;b&quot; &#39;c&#39; &#x1F600;"), "a <3 > \"b\" 'c' 😀");
  });

  it("leaves unknown escapes and bare ampersands alone", () => {
    assert.equal(decodeEntities("Tom & Jerry &unknown;"), "Tom & Jerry &unknown;");
  });
});
