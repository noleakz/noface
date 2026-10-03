import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultFastMode } from '../docs/video-mode.mjs';

test('fast mode starts on a phone even when the primary pointer query reports fine', () => {
  assert.equal(defaultFastMode({ viewportWidth: 390, viewportHeight: 844, screenWidth: 390, screenHeight: 844, touchPoints: 1, coarsePointer: false }), true);
});

test('fast mode starts on a phone in landscape and stays optional on desktop', () => {
  assert.equal(defaultFastMode({ viewportWidth: 844, viewportHeight: 390, screenWidth: 390, screenHeight: 844, touchPoints: 1, coarsePointer: false }), true);
  assert.equal(defaultFastMode({ viewportWidth: 1440, viewportHeight: 900, screenWidth: 1440, screenHeight: 900, touchPoints: 0, coarsePointer: false }), false);
});
