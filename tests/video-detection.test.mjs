import assert from 'node:assert/strict';
import test from 'node:test';
import { detectWithFallback } from '../docs/video-detection.mjs';

test('a failing small check retries at full size and remembers the fallback', async () => {
  const sides = [];
  const detector = { async detect(_source, side) {
    sides.push(side);
    if (side === 320) throw new Error('small input failed');
    return [{ originX: 1, originY: 2, width: 3, height: 4 }];
  } };
  const state = { smallChecksFailed: false };
  const first = await detectWithFallback(detector, {}, 320, state);
  const second = await detectWithFallback(detector, {}, 320, state);
  assert.deepEqual(first, second);
  assert.equal(state.smallChecksFailed, true);
  assert.deepEqual(sides, [320, 960, 960]);
});
