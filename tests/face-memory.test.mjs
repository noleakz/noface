import assert from 'node:assert/strict';
import test from 'node:test';
import { FaceMemory } from '../dist/face-memory.mjs';

const face = (x, y = 60) => ({ originX: x, originY: y, width: 40, height: 40 });
const covers = (box, x, y) => box.originX <= x && box.originY <= y &&
  box.originX + box.width >= x && box.originY + box.height >= y;

test('a detected face stays masked through a short detection gap', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  for (const time of [0.033, 0.066, 0.1]) {
    const boxes = memory.update([], time);
    assert.ok(boxes.some((box) => covers(box, 120, 80)), `face uncovered at ${time}s`);
  }
});

test('a moving face keeps its old and predicted positions masked', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  memory.update([face(110)], 0.1);
  const boxes = memory.update([], 0.2);
  assert.ok(boxes.some((box) => covers(box, 105, 80)));
  assert.ok(boxes.some((box) => covers(box, 145, 80)));
});

test('an unmoving face does not grow during a detection gap', () => {
  const memory = new FaceMemory();
  const original = face(100);
  memory.update([original], 0);
  for (const time of [0.25, 0.5, 1, 1.5, 2]) {
    assert.deepEqual(memory.update([], time), [original], `mask changed at ${time}s`);
  }
});

test('motion prediction stops expanding during a long detection gap', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  memory.update([face(110)], 0.1);
  const shortGap = memory.update([], 0.35);
  for (const time of [0.6, 1, 2]) {
    assert.deepEqual(memory.update([], time), shortGap, `mask expanded at ${time}s`);
  }
});

test('two face positions stay separate instead of becoming one oversized mask', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  const boxes = memory.update([face(130)], 0.1);
  assert.ok(boxes.some((box) => covers(box, 120, 80)));
  assert.ok(boxes.some((box) => covers(box, 150, 80)));
  assert.ok(boxes.every((box) => box.width <= 40 && box.height <= 40));
});

test('detector jitter and a missed frame do not enlarge face rectangles', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  memory.update([face(108)], 0.033);
  const boxes = memory.update([], 0.1);
  assert.ok(boxes.every((box) => box.width <= 40 && box.height <= 40));
});

test('repeated jitter and detection gaps never accumulate mask size', () => {
  const memory = new FaceMemory();
  for (let frame = 0; frame < 120; frame++) {
    const detections = frame % 5 === 4 ? [] : [face(100 + (frame % 3) * 4)];
    const boxes = memory.update(detections, frame / 30);
    assert.ok(boxes.length <= 3, `too many masks at frame ${frame}`);
    assert.ok(boxes.every((box) => box.width === 40 && box.height === 40), `mask enlarged at frame ${frame}`);
  }
});

test('one missed face stays masked while another is detected', () => {
  const memory = new FaceMemory();
  memory.update([face(100), face(400)], 0);
  const boxes = memory.update([face(405)], 0.1);
  assert.ok(boxes.some((box) => covers(box, 120, 80)));
  assert.ok(boxes.some((box) => covers(box, 425, 80)));
});

test('old masks expire and a seek clears memory', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 0);
  assert.equal(memory.update([], 3).length, 0);
  memory.update([face(100)], 4);
  memory.reset();
  assert.equal(memory.update([], 4.1).length, 0);
});

test('going backward in the video discards future face positions', () => {
  const memory = new FaceMemory();
  memory.update([face(100)], 10);
  assert.equal(memory.update([], 2).length, 0);
});
