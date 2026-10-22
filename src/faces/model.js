import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

// Faces in an image, and a fingerprint for each: InsightFace's "buffalo_s"
// models, run with ONNX Runtime — SCRFD-500M finds faces and their five
// landmarks (eyes, nose, mouth corners), MobileFaceNet (ArcFace) turns each
// face, lined up to a standard 112×112, into 512 numbers that are close
// for the same person and far apart for different people.
//
// archive-web runs the very same model files in the browser to fingerprint
// a photo to search with, so its fingerprints compare with these. Change a
// step here (sizes, normalisation, alignment) and the web side must change
// with it — and every face be fingerprinted again.

const MODELS = new URL("../../models/", import.meta.url);

// The detector looks at the image fitted into a 640×640 square.
const DET_SIZE = 640;
const STRIDES = [8, 16, 32];
const ANCHORS = 2;
// A face is kept when the detector is at least this sure of it, and its box
// is at least this many pixels on its shorter side: smaller faces give
// fingerprints too blurry to match on.
const MIN_SCORE = 0.5;
const MIN_SIZE = 32;
// Overlapping boxes for the same face: the surest one is kept.
const NMS_IOU = 0.4;

// Where ArcFace expects the five landmarks in its 112×112 face.
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
const FACE = 112;

let sessions = null;
async function load() {
  sessions ??= Promise.all(
    ["det_500m.onnx", "w600k_mbf.onnx"].map((f) =>
      ort.InferenceSession.create(fileURLToPath(new URL(f, MODELS))),
    ),
  ).then(([detector, recognizer]) => ({ detector, recognizer }));
  return sessions;
}

/* ===================== DETECTION ===================== */

// The image fitted into the detector's square — scaled to touch its right or
// bottom edge, the rest black — as the detector's input: RGB planes, each
// value (v − 127.5) / 128.
async function detectorInput({ data, width, height }) {
  const scale = Math.min(DET_SIZE / width, DET_SIZE / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const fitted = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize(w, h, { fit: "fill" })
    .extend({ right: DET_SIZE - w, bottom: DET_SIZE - h, background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer();
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (fitted[i * 3 + c] - 127.5) / 128;
  }
  return { tensor: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]), scale };
}

const iou = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
};

// The faces SCRFD finds: [{ box: [x1, y1, x2, y2], score, landmarks }], in
// the image's own pixels, surest first. Its outputs are, per stride, the
// scores, then the box distances, then the landmark offsets — each for two
// anchors at every cell of the stride's grid.
async function detect(detector, image) {
  const { tensor, scale } = await detectorInput(image);
  const out = await detector.run({ [detector.inputNames[0]]: tensor });
  const names = detector.outputNames;
  const found = [];
  STRIDES.forEach((stride, s) => {
    const scores = out[names[s]].data;
    const boxes = out[names[s + STRIDES.length]].data;
    const kps = out[names[s + 2 * STRIDES.length]].data;
    const cols = DET_SIZE / stride;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < MIN_SCORE) continue;
      const cell = Math.floor(i / ANCHORS);
      const cx = (cell % cols) * stride;
      const cy = Math.floor(cell / cols) * stride;
      const box = [
        (cx - boxes[i * 4] * stride) / scale,
        (cy - boxes[i * 4 + 1] * stride) / scale,
        (cx + boxes[i * 4 + 2] * stride) / scale,
        (cy + boxes[i * 4 + 3] * stride) / scale,
      ];
      const landmarks = Array.from({ length: 5 }, (_, k) => [
        (cx + kps[i * 10 + k * 2] * stride) / scale,
        (cy + kps[i * 10 + k * 2 + 1] * stride) / scale,
      ]);
      found.push({ box, score: scores[i], landmarks });
    }
  });
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const face of found) {
    if (kept.every((k) => iou(k.box, face.box) < NMS_IOU)) kept.push(face);
  }
  return kept.filter(
    ({ box }) => Math.min(box[2] - box[0], box[3] - box[1]) >= MIN_SIZE,
  );
}

/* ===================== FINGERPRINT ===================== */

// The similarity transform (scale, rotation, shift) that best moves the
// face's landmarks onto the template, by least squares: as
// [a, -b, tx; b, a, ty].
function similarity(src, dst) {
  const mean = (pts) => [0, 1].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const [sx, sy] = mean(src);
  const [dx, dy] = mean(dst);
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  src.forEach(([x, y], i) => {
    const ax = x - sx;
    const ay = y - sy;
    const bx = dst[i][0] - dx;
    const by = dst[i][1] - dy;
    num1 += ax * bx + ay * by;
    num2 += ax * by - ay * bx;
    den += ax * ax + ay * ay;
  });
  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

// The face lined up into ArcFace's 112×112, as the recognizer's input: each
// output pixel taken from where the transform says it came from (bilinear,
// black outside the image), RGB planes, each value (v − 127.5) / 127.5.
function aligned({ data, width, height }, landmarks) {
  const { a, b, tx, ty } = similarity(landmarks, TEMPLATE);
  const det = a * a + b * b;
  const plane = FACE * FACE;
  const input = new Float32Array(3 * plane);
  const at = (x, y, c) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + c];
  for (let v = 0; v < FACE; v++) {
    for (let u = 0; u < FACE; u++) {
      // The inverse of the transform: where in the image this pixel is.
      const px = (a * (u - tx) + b * (v - ty)) / det;
      const py = (-b * (u - tx) + a * (v - ty)) / det;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      for (let c = 0; c < 3; c++) {
        const value =
          at(x0, y0, c) * (1 - fx) * (1 - fy) +
          at(x0 + 1, y0, c) * fx * (1 - fy) +
          at(x0, y0 + 1, c) * (1 - fx) * fy +
          at(x0 + 1, y0 + 1, c) * fx * fy;
        input[c * plane + v * FACE + u] = (value - 127.5) / 127.5;
      }
    }
  }
  return new ort.Tensor("float32", input, [1, 3, FACE, FACE]);
}

async function fingerprint(recognizer, image, landmarks) {
  const out = await recognizer.run({ [recognizer.inputNames[0]]: aligned(image, landmarks) });
  const v = out[recognizer.outputNames[0]].data;
  const norm = Math.hypot(...v);
  return Array.from(v, (x) => x / norm);
}

/* ===================== API ===================== */

// Every face in an image (its bytes, any common format), surest first:
// [{ box: [x1, y1, x2, y2], score, embedding: number[512] }], box in the
// image's pixels and embedding of length 1, so two faces' similarity is
// their dot product.
export async function facesIn(bytes) {
  const { detector, recognizer } = await load();
  const { data, info } = await sharp(bytes)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = { data, width: info.width, height: info.height };
  const faces = await detect(detector, image);
  return Promise.all(
    faces.map(async ({ box, score, landmarks }) => ({
      box: box.map((n) => Math.round(n)),
      score: Math.round(score * 1000) / 1000,
      embedding: await fingerprint(recognizer, image, landmarks),
    })),
  );
}
