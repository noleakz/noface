import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModelBytes } from '../docs/model-cache.mjs';

test('a downloaded model is reused on the next visit', async () => {
  const saved = new Map();
  const storage = { open: async () => ({
    match: async (key) => saved.get(key)?.clone(),
    put: async (key, response) => { saved.set(key, response.clone()); },
    delete: async (key) => saved.delete(key)
  }) };
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return new Response(new Uint8Array(2048).fill(7));
  };
  const first = await loadModelBytes('https://example.org/model.onnx', { storage, fetcher });
  const second = await loadModelBytes('https://example.org/model.onnx', { storage, fetcher });
  assert.equal(requests, 1);
  assert.deepEqual(second, first);
});

test('storage denial still allows model loading', async () => {
  const storage = { open: async () => { throw new Error('storage unavailable'); } };
  const bytes = await loadModelBytes('https://example.org/model.onnx', {
    storage,
    fetcher: async () => new Response(new Uint8Array(2048))
  });
  assert.equal(bytes.byteLength, 2048);
});

test('an incomplete model is rejected instead of cached', async () => {
  await assert.rejects(loadModelBytes('https://example.org/model.onnx', {
    storage: null,
    fetcher: async () => new Response(new Uint8Array(50))
  }), /incomplet/);
});
