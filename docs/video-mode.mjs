export function defaultFastMode({ viewportWidth, viewportHeight, screenWidth, screenHeight, touchPoints, coarsePointer }) {
  const shortestSide = Math.min(viewportWidth, viewportHeight, screenWidth, screenHeight);
  return shortestSide <= 600 || (shortestSide <= 1024 && (touchPoints > 0 || coarsePointer));
}
