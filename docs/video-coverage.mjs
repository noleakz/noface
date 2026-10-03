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

export function videoScanPlan(duration, mode = 'fast') {
  if (mode === 'careful') return {
    times: analysisTimes(duration, 30), detailTimes: [], maxSide: 960
  };
  return {
    times: analysisTimes(duration, 12), detailTimes: analysisTimes(duration, 1), maxSide: 320
  };
}

export function scanChecks({ times, detailTimes, maxSide }) {
  const checks = new Map(times.map((time) => [Math.round(time * 1000), { time, maxSide, detail: false }]));
  for (const time of detailTimes) checks.set(Math.round(time * 1000), { time, maxSide: 960, detail: true });
  return [...checks.values()].sort((a, b) => a.time - b.time);
}

export function videoOutputSize(width, height, fast) {
  if (!fast) return { width, height };
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return {
    width: Math.max(2, Math.round(width * scale / 2) * 2),
    height: Math.max(2, Math.round(height * scale / 2) * 2)
  };
}

export function scaleBox(box, sourceWidth, sourceHeight, outputWidth, outputHeight) {
  const xScale = outputWidth / sourceWidth;
  const yScale = outputHeight / sourceHeight;
  return {
    originX: box.originX * xScale,
    originY: box.originY * yScale,
    width: box.width * xScale,
    height: box.height * yScale
  };
}

function sweptBoxes(before, after) {
  const first = before.detections ?? before.boxes;
  const second = after.detections ?? after.boxes;
  const used = new Set();
  const boxes = [];
  for (const start of first) {
    let matchIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < second.length; index++) {
      if (used.has(index)) continue;
      const end = second[index];
      const x = (start.originX + start.width / 2 - end.originX - end.width / 2) / Math.max(1, start.width, end.width);
      const y = (start.originY + start.height / 2 - end.originY - end.height / 2) / Math.max(1, start.height, end.height);
      const distance = Math.hypot(x, y);
      if (distance < bestDistance) { matchIndex = index; bestDistance = distance; }
    }
    if (matchIndex < 0 || (bestDistance > 3 && (first.length !== 1 || second.length !== 1))) continue;
    used.add(matchIndex);
    const end = second[matchIndex];
    const left = Math.min(start.originX, end.originX);
    const top = Math.min(start.originY, end.originY);
    boxes.push({
      originX: left,
      originY: top,
      width: Math.max(start.originX + start.width, end.originX + end.width) - left,
      height: Math.max(start.originY + start.height, end.originY + end.height) - top
    });
  }
  return boxes;
}

export function coverageAt(frames, time, { sweep = true } = {}) {
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
  const boxes = before === after ? [...before.boxes] : [
    ...before.boxes, ...after.boxes, ...(sweep ? sweptBoxes(before, after) : [])
  ];
  if (after.time === time && low < frames.length - 1) boxes.push(...frames[low + 1].boxes);
  return boxes;
}
