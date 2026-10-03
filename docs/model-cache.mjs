const CACHE_NAME = 'noface-models-v1';

export async function loadModelBytes(url, { storage = globalThis.caches, fetcher = globalThis.fetch } = {}) {
  let cache;
  try {
    cache = await storage?.open(CACHE_NAME);
    const saved = await cache?.match(url);
    if (saved) {
      const bytes = new Uint8Array(await saved.arrayBuffer());
      if (bytes.byteLength > 1024) return bytes;
      await cache.delete(url);
    }
  } catch (error) {
    // Private browsing or a full storage quota must not prevent model loading.
    cache = null;
  }

  const response = await fetcher(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Téléchargement du modèle impossible (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength <= 1024) throw new Error('Le modèle téléchargé est incomplet.');
  try {
    await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (error) {
    // The model remains usable for this visit even when local storage fails.
  }
  return bytes;
}
