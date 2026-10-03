// CenterFace's preprocessing and box decoding follow Star-Clouds/CenterFace
// (MIT): https://github.com/Star-Clouds/CenterFace/blob/master/prj-python/centerface.py
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
// The upstream ONNX file declares a fixed 10x3x32x32 input. This copy changes
// only the declared input shape so ONNX Runtime can accept real image sizes.
const MODEL_URL = 'https://huggingface.co/SCKEMPER/centerface-dynamic/resolve/main/centerface-dynamic.onnx';

const nextMultipleOf32 = (value) => Math.ceil(value / 32) * 32;

export function rgbPlanesFromRgba(rgba) {
  const plane = rgba.length / 4;
  const pixels = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    pixels[i] = rgba[i * 4];
    pixels[plane + i] = rgba[i * 4 + 1];
    pixels[plane * 2 + i] = rgba[i * 4 + 2];
  }
  return pixels;
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.originX, b.originX);
  const top = Math.max(a.originY, b.originY);
  const right = Math.min(a.originX + a.width, b.originX + b.width);
  const bottom = Math.min(a.originY + a.height, b.originY + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

export function decodeCenterFace(outputs, sourceWidth, sourceHeight, inputWidth, inputHeight, threshold = 0.25) {
  const heatmap = outputs['537'];
  const scale = outputs['538'];
  const offset = outputs['539'];
  const rows = inputHeight / 4;
  const columns = inputWidth / 4;
  const plane = rows * columns;
  const hasShape = (tensor, channels) => tensor?.dims?.length === 4 &&
    tensor.dims[0] === 1 && tensor.dims[1] === channels &&
    tensor.dims[2] === rows && tensor.dims[3] === columns;
  if (!heatmap || !scale || !offset ||
      !hasShape(heatmap, 1) || !hasShape(scale, 2) || !hasShape(offset, 2) ||
      heatmap.data.length !== plane || scale.data.length !== plane * 2 || offset.data.length !== plane * 2)
    throw new Error('Sortie CenterFace inattendue.');

  const candidates = [];
  for (let i = 0; i < plane; i++) {
    const score = heatmap.data[i];
    if (!Number.isFinite(score)) throw new Error('Score CenterFace invalide.');
    if (score < threshold) continue;
    const row = Math.floor(i / columns);
    const column = i % columns;
    const height = Math.exp(scale.data[i]) * 4;
    const width = Math.exp(scale.data[plane + i]) * 4;
    const x = Math.max(0, Math.min(inputWidth, (column + offset.data[plane + i] + 0.5) * 4 - width / 2));
    const y = Math.max(0, Math.min(inputHeight, (row + offset.data[i] + 0.5) * 4 - height / 2));
    const right = Math.min(inputWidth, x + width);
    const bottom = Math.min(inputHeight, y + height);
    if (!Number.isFinite(right + bottom)) throw new Error('Rectangle CenterFace invalide.');
    if (right <= x || bottom <= y) continue;
    candidates.push({
      originX: x * sourceWidth / inputWidth,
      originY: y * sourceHeight / inputHeight,
      width: (right - x) * sourceWidth / inputWidth,
      height: (bottom - y) * sourceHeight / inputHeight,
      score
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of candidates) {
    if (kept.every((other) => intersectionOverUnion(box, other) < 0.3)) kept.push(box);
  }
  return kept.map(({ score, ...box }) => box);
}

export class CenterFaceDetector {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.loadPromise = null;
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const ort = await import(`${ORT_BASE}ort.min.mjs`);
        ort.env.wasm.wasmPaths = ORT_BASE;
        ort.env.wasm.numThreads = 1;
        const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
        if (session.outputNames.length < 3 || !['537', '538', '539'].every((name) => session.outputNames.includes(name)))
          throw new Error('Version du modèle CenterFace non reconnue.');
        this.ort = ort;
        this.session = session;
      })();
    }
    return this.loadPromise;
  }

  async detect(source, maxSide = 960) {
    await this.load();
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const ratio = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const inputWidth = nextMultipleOf32(Math.max(32, Math.round(sourceWidth * ratio)));
    const inputHeight = nextMultipleOf32(Math.max(32, Math.round(sourceHeight * ratio)));
    this.canvas.width = inputWidth;
    this.canvas.height = inputHeight;
    this.context.drawImage(source, 0, 0, inputWidth, inputHeight);
    const rgba = this.context.getImageData(0, 0, inputWidth, inputHeight).data;
    const pixels = rgbPlanesFromRgba(rgba);
    const tensor = new this.ort.Tensor('float32', pixels, [1, 3, inputHeight, inputWidth]);
    let outputs;
    try {
      outputs = await this.session.run({ [this.session.inputNames[0]]: tensor });
      return decodeCenterFace(outputs, sourceWidth, sourceHeight, inputWidth, inputHeight);
    } finally {
      tensor.dispose?.();
      for (const output of Object.values(outputs || {})) output.dispose?.();
    }
  }
}
