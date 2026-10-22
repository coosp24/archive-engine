// A model as luckycrush recommends her to a signed-up man
// (GET /buurn/r/model-recommendations):
//   { uhidB, pseudo, avatarUrl (200 px), avatarUrlLarge (500 px), isAvailable }
// turned into what the archive keeps: { modelId, name, avatar } — her
// avatar the larger size, each null when it doesn't say. That's all
// luckycrush shows of anyone.

const ID = /^[A-Za-z0-9_-]{10,40}$/;
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function shapeModel(m) {
  const id = text(m.uhidB);
  return {
    modelId: id && ID.test(id) ? id : null,
    name: text(m.pseudo),
    avatar: text(m.avatarUrlLarge) ?? text(m.avatarUrl),
  };
}
