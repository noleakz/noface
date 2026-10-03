import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCenterFace, rgbPlanesFromRgba, sourceDimensions } from '../docs/centerface.mjs';

function tensors(width = 32, height = 32) {
  const plane = width * height / 16;
  return {
    '537': { dims: [1, 1, height / 4, width / 4], data: new Float32Array(plane) },
    '538': { dims: [1, 2, height / 4, width / 4], data: new Float32Array(plane * 2) },
    '539': { dims: [1, 2, height / 4, width / 4], data: new Float32Array(plane * 2) }
  };
}

test('decodes a CenterFace box into original image coordinates', () => {
  const outputs = tensors();
  outputs['537'].data[2 * 8 + 3] = 0.8;
  assert.deepEqual(decodeCenterFace(outputs, 64, 64, 32, 32), [
    { originX: 24, originY: 16, width: 8, height: 8 }
  ]);
});

test('suppresses overlapping lower confidence boxes but keeps distinct faces', () => {
  const outputs = tensors();
  for (const [row, column, score] of [[3, 3, 0.9], [3, 4, 0.7], [6, 6, 0.8]]) {
    const index = row * 8 + column;
    outputs['537'].data[index] = score;
    outputs['538'].data[index] = Math.log(4);
    outputs['538'].data[64 + index] = Math.log(4);
  }
  const boxes = decodeCenterFace(outputs, 32, 32, 32, 32);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.some((box) => box.originX <= 12 && box.originX + box.width >= 12));
  assert.ok(boxes.some((box) => box.originX <= 24 && box.originX + box.width >= 24));
});

test('rejects output tensors with an unexpected shape', () => {
  assert.throws(() => decodeCenterFace({ '537': { data: [] } }, 32, 32, 32, 32), /Sortie CenterFace/);
});

test('feeds RGB color planes without alpha or normalization', () => {
  const rgba = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 0]);
  assert.deepEqual([...rgbPlanesFromRgba(rgba)], [10, 40, 20, 50, 30, 60]);
});

test('uses video frame dimensions when analyzing a video directly', () => {
  assert.deepEqual(sourceDimensions({ width: 0, height: 0, videoWidth: 1920, videoHeight: 1080 }), {
    width: 1920, height: 1080
  });
});
