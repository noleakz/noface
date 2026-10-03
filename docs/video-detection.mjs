export async function detectWithFallback(detector, source, maxSide, state) {
  const side = state.smallChecksFailed ? 960 : maxSide;
  try {
    return await detector.detect(source, side);
  } catch (error) {
    if (side >= 960) throw error;
    const boxes = await detector.detect(source, 960);
    state.smallChecksFailed = true;
    return boxes;
  }
}
