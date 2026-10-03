export function photoOutputSize(width, height, compactDevice) {
  const limit = compactDevice ? 2048 : Infinity;
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
