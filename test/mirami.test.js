import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeGirl, shapeInfo, shapePhoto, shapeReel } from "../src/sites/mirami/girl.js";

// A reel as mirami's API sends it (ids and keys made up).
const REEL = {
  id: 7447531,
  name: "",
  description: "",
  is_premium: false,
  video: { url: "https://s1.rda.la/A/B/video_short/abc.mp4", mime: "video/mp4" },
  video_poster: { url: "https://s1.rda.la/A/B/video_short/def.webp", mime: "image/jpeg", height: 150, width: 300 },
  on_processing: false,
  is_viewed: false,
  is_published: 1,
  likes_count: 296,
  is_liked: false,
  user: {
    id: 59543491,
    name: "Full Legal Name",
    nick: " Юлия ",
    country: "ua",
    sex: "F",
    age: 30,
    avatarUrl: "https://s1.rda.la/A/B/user/profile/image/main_crop428x428_KEY.webp",
    refCode: "T7XZH07V",
    totalLikesCount: null,
    statusOnline: "offline",
  },
};

// Her profile (GET /girl_info).
const INFO = {
  user_id: "59543491",
  last_visit: "2026-10-17 23:10:41.113729",
  nick: "Юлия",
  age: "30",
  about: "hi",
  avatar_url: "https://s1.rda.la/A/B/user/profile/image/main_crop428x428_NEW.webp",
  status: "busy",
  count_favourites: "36",
  count_likes: 315,
  count_gifts: 4,
  is_verify: "1",
  birthday: "1996-01-03",
};

describe("mirami shapeReel", () => {
  it("keeps what the archive stores — her nick as her name, her name apart — and leaves the rest out", () => {
    assert.deepEqual(shapeReel(REEL), {
      modelId: "59543491",
      refCode: "T7XZH07V",
      name: "Юлия",
      profileName: "Full Legal Name",
      avatar: "https://s1.rda.la/A/B/user/profile/image/main_crop428x428_KEY.webp",
      country: "UA",
      age: 30,
      online: false,
      storyId: "7447531",
      src: "https://s1.rda.la/A/B/video_short/abc.mp4",
      preview: "https://s1.rda.la/A/B/video_short/def.webp",
      likes: 296,
    });
  });

  it("leaves what the reel doesn't say as null: an empty avatar is none", () => {
    const reel = shapeReel({ id: 1, user: { avatarUrl: "", statusOnline: "away", age: null } });
    assert.equal(reel.storyId, "1");
    assert.equal(reel.modelId, null);
    assert.equal(reel.avatar, null);
    assert.equal(reel.online, null);
    assert.equal(reel.age, null);
    assert.equal(reel.src, null);
  });
});

describe("mirami shapeInfo", () => {
  it("reads her profile: counts as numbers, busy as online, the last visit as UTC", () => {
    assert.deepEqual(shapeInfo(INFO), {
      name: "Юлия",
      avatar: "https://s1.rda.la/A/B/user/profile/image/main_crop428x428_NEW.webp",
      online: true,
      siteLastVisitAt: "2026-10-17T23:10:41.113729Z",
      about: "hi",
      birthday: "1996-01-03",
      age: 30,
      verified: true,
      likesCount: 315,
      favouritesCount: 36,
      giftsCount: 4,
    });
  });

  it("leaves what the profile doesn't say as null", () => {
    const info = shapeInfo({ last_visit: "yesterday", birthday: "03/01/1996", is_verify: null, count_likes: -2 });
    assert.equal(info.siteLastVisitAt, null);
    assert.equal(info.birthday, null);
    assert.equal(info.verified, null);
    assert.equal(info.likesCount, null);
  });
});

describe("mirami mergeGirl", () => {
  it("lays her profile and the girls lists over the reel", () => {
    const record = mergeGirl(shapeReel(REEL), shapeInfo(INFO), { shows_count: 804, likes_count: 1 });
    assert.equal(record.avatar, INFO.avatar_url);
    assert.equal(record.online, true);
    assert.equal(record.likesCount, 315);
    assert.equal(record.showsCount, 804);
    assert.equal(record.giftsCount, 4);
    assert.equal(record.likes, 296);
  });

  it("keeps the reel's word when there's no profile (her account is gone)", () => {
    const record = mergeGirl(shapeReel(REEL), null, undefined);
    assert.equal(record.name, "Юлия");
    assert.equal(record.online, false);
    assert.equal(record.about, null);
    assert.equal(record.showsCount, null);
  });
});

describe("mirami shapePhoto", () => {
  const OPEN = {
    id: 7442938,
    type: "gallery",
    is_premium: 0,
    likes_count: 4,
    create_time: "2026-10-14 17:59:03.125239",
    main_image: { url: "https://s1.rda.la/A/B/user/profile/gallery/main_crop428x428_K.webp" },
    original_image: { url: "https://s1.rda.la/A/B/user/profile/gallery/original_resize1920x1080_K.webp" },
  };

  it("keeps an open photo's pictures, date and likes", () => {
    assert.deepEqual(shapePhoto(OPEN, "52691063"), {
      id: "7442938",
      modelId: "52691063",
      kind: "gallery",
      premium: false,
      image: "https://s1.rda.la/A/B/user/profile/gallery/main_crop428x428_K.webp",
      original: "https://s1.rda.la/A/B/user/profile/gallery/original_resize1920x1080_K.webp",
      postedAt: "2026-10-14T17:59:03.125239Z",
      likes: 4,
    });
  });

  it("keeps a Premium-only photo without its blurred pictures", () => {
    const photo = shapePhoto(
      {
        ...OPEN,
        is_premium: 1,
        main_image: { url: "https://s1.rda.la/A/B/user/profile/gallery/blur_X.webp" },
        original_image: { url: "https://s1.rda.la/A/B/user/profile/gallery/blur_Y.webp" },
      },
      "52691063",
    );
    assert.equal(photo.premium, true);
    assert.equal(photo.image, null);
    assert.equal(photo.original, null);
    assert.equal(photo.likes, 4);
  });
});
