import assert from 'node:assert/strict';
import test from 'node:test';
import { photoOutputSize } from '../docs/photo-processing.mjs';

test('large phone photos use a smaller canvas without changing proportions', () => {
  assert.deepEqual(photoOutputSize(4000, 3000, true), { width: 2048, height: 1536 });
  assert.deepEqual(photoOutputSize(3000, 4000, true), { width: 1536, height: 2048 });
});

test('small photos keep their size', () => {
  assert.deepEqual(photoOutputSize(1200, 900, true), { width: 1200, height: 900 });
  assert.deepEqual(photoOutputSize(6000, 4000, false), { width: 6000, height: 4000 });
});
