export function analysisTimes(duration, samplesPerSecond = 20) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durée vidéo invalide.');
  const last = Math.max(0, duration - 0.001);
  const count = Math.ceil(last * samplesPerSecond);
  const times = [];
  for (let index = 0; index <= count; index++) {
    const time = Math.min(last, index / samplesPerSecond);
    if (time > (times.at(-1) ?? -1)) times.push(time);
  }
  if (times.at(-1) < last) times.push(last);
  return times;
}

export function coverageAt(frames, time) {
  if (!frames.length) return [];
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const before = frames[Math.max(0, low - 1)];
  const after = frames[Math.min(frames.length - 1, low)];
  const boxes = before === after ? [...before.boxes] : [...before.boxes, ...after.boxes];
  if (after.time === time && low < frames.length - 1) boxes.push(...frames[low + 1].boxes);
  return boxes;
}
