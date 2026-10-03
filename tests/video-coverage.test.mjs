import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisTimes, coverageAt, scaleBox, scanChecks, videoOutputSize, videoScanPlan } from '../docs/video-coverage.mjs';

test('analysis includes the start and final visible part of a video', () => {
  const times = analysisTimes(0.23, 10);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 0.229);
  assert.ok(times.every((time, index) => !index || time > times[index - 1]));
});

test('video frames between samples cover positions from both neighbors', () => {
  const left = { originX: 10, originY: 10, width: 20, height: 20 };
  const right = { originX: 80, originY: 10, width: 20, height: 20 };
  const frames = [{ time: 0, boxes: [left] }, { time: 0.1, boxes: [right] }];
  const between = coverageAt(frames, 0.05);
  assert.ok(between.includes(left));
  assert.ok(between.includes(right));
  assert.ok(between.some((box) => box.originX <= 10 && box.originX + box.width >= 100));
  assert.ok(coverageAt(frames, 0).includes(left));
  assert.ok(coverageAt(frames, 0).includes(right));
  assert.deepEqual(coverageAt(frames, 0.2), [right]);
});

test('a moving face stays covered along the path between checked frames', () => {
  const first = { originX: 10, originY: 20, width: 20, height: 20 };
  const second = { originX: 30, originY: 20, width: 20, height: 20 };
  const frames = [{ time: 0, boxes: [first], detections: [first] }, { time: 0.1, boxes: [second], detections: [second] }];
  const covers = coverageAt(frames, 0.05);
  assert.ok(covers.some((box) => box.originX <= 20 && box.originX + box.width >= 40));
});

test('the bridge between positions does not keep growing from older remembered boxes', () => {
  const old = { originX: 0, originY: 20, width: 10, height: 10 };
  const first = { originX: 30, originY: 20, width: 10, height: 10 };
  const second = { originX: 50, originY: 20, width: 10, height: 10 };
  const frames = [
    { time: 0, boxes: [old, first], detections: [first] },
    { time: 0.1, boxes: [old, second], detections: [second] }
  ];
  const covers = coverageAt(frames, 0.05);
  assert.ok(covers.includes(old));
  assert.ok(covers.some((box) => box.originX === 30 && box.width === 30));
  assert.ok(!covers.some((box) => box.originX === 0 && box.width > 10));
  assert.deepEqual(coverageAt(frames, 0.05, { sweep: false }), [old, first, old, second]);
});

test('phone output is smaller and detected boxes scale into it', () => {
  assert.deepEqual(videoOutputSize(1920, 1080, true), { width: 1280, height: 720 });
  assert.deepEqual(videoOutputSize(1080, 1920, true), { width: 720, height: 1280 });
  assert.deepEqual(videoOutputSize(1920, 1080, false), { width: 1920, height: 1080 });
  assert.deepEqual(scaleBox({ originX: 960, originY: 540, width: 480, height: 270 }, 1920, 1080, 1280, 720), {
    originX: 640, originY: 360, width: 320, height: 180
  });
});

test('fast scan uses far fewer small checks and keeps regular full-size checks', () => {
  const fast = videoScanPlan(10, 'fast');
  const careful = videoScanPlan(10, 'careful');
  assert.equal(careful.detailTimes.length, 0);
  assert.equal(careful.maxSide, 960);
  assert.equal(fast.maxSide, 320);
  assert.ok(fast.times.length < careful.times.length / 2);
  assert.ok(fast.detailTimes.length >= 10);
  assert.ok(fast.detailTimes.every((time, index) => !index || time - fast.detailTimes[index - 1] <= 1.001));
  const fullSizeEquivalent = fast.times.length * (fast.maxSide / careful.maxSide) ** 2 + fast.detailTimes.length;
  assert.ok(fullSizeEquivalent < careful.times.length / 8);
});

test('full-size checks cover neighboring fast samples before and after detection', () => {
  const face = { originX: 20, originY: 20, width: 10, height: 10 };
  const frames = [{ time: 0, boxes: [] }, { time: 1, boxes: [face] }, { time: 2, boxes: [] }];
  assert.ok(coverageAt(frames, 0.5).includes(face));
  assert.ok(coverageAt(frames, 1.5).includes(face));
});

test('fast scan checks frames in time order without repeating a frame', () => {
  const plan = videoScanPlan(10, 'fast');
  const checks = scanChecks(plan);
  assert.ok(checks.every((check, index) => !index || checks[index - 1].time < check.time));
  assert.equal(new Set(checks.map((check) => Math.round(check.time * 1000))).size, checks.length);
  assert.ok(checks.some((check) => check.detail && check.maxSide === 960));
  assert.ok(checks.some((check) => !check.detail && check.maxSide === 320));
});
