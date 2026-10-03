import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisTimes, coverageAt } from '../docs/video-coverage.mjs';

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
  assert.deepEqual(coverageAt(frames, 0.05), [left, right]);
  assert.deepEqual(coverageAt(frames, 0), [left, right]);
  assert.deepEqual(coverageAt(frames, 0.2), [right]);
});
