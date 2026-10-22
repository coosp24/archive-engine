import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shapeModel } from "../src/sites/luckycrush/model.js";

describe("luckycrush shapeModel", () => {
  it("keeps her id, name and larger avatar", () => {
    assert.deepEqual(
      shapeModel({
        uhidB: "5Zg46TT-te9kkj5eVKur",
        pseudo: " Alissa_Alice ",
        avatarUrl: "https://imagedelivery.net/K/production_5Zg46TT-te9kkj5eVKur_x/profile200?v=31",
        avatarUrlLarge: "https://imagedelivery.net/K/production_5Zg46TT-te9kkj5eVKur_x/profile500?v=31",
        isAvailable: 1,
      }),
      {
        modelId: "5Zg46TT-te9kkj5eVKur",
        name: "Alissa_Alice",
        avatar: "https://imagedelivery.net/K/production_5Zg46TT-te9kkj5eVKur_x/profile500?v=31",
      },
    );
  });

  it("falls back to the small avatar, and refuses an id that isn't one", () => {
    const model = shapeModel({ uhidB: "short", avatarUrl: "https://x/profile200" });
    assert.equal(model.modelId, null);
    assert.equal(model.avatar, "https://x/profile200");
    assert.equal(model.name, null);
  });
});
