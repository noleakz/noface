const centerX = (box) => box.originX + box.width / 2;
const centerY = (box) => box.originY + box.height / 2;
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

const sameBox = (a, b) => a.originX === b.originX && a.originY === b.originY &&
  a.width === b.width && a.height === b.height;

export class FaceMemory {
  constructor({ holdSeconds = 2, maxPredictionSeconds = 0.25 } = {}) {
    this.holdSeconds = holdSeconds;
    this.maxPredictionSeconds = maxPredictionSeconds;
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.lastTime = -Infinity;
  }

  update(boxes, time) {
    if (!Number.isFinite(time)) throw new Error('Invalid video time.');
    if (time < this.lastTime - 0.01) this.reset();
    this.lastTime = time;
    this.tracks = this.tracks.filter((track) => time - track.seenAt <= this.holdSeconds);

    const matched = new Set();
    for (const box of boxes) {
      let best = null;
      let bestDistance = Infinity;
      for (const track of this.tracks) {
        if (matched.has(track)) continue;
        const age = Math.min(Math.max(0, time - track.seenAt), this.maxPredictionSeconds);
        const expectedX = centerX(track.box) + track.vx * age;
        const expectedY = centerY(track.box) + track.vy * age;
        const width = Math.max(box.width, track.box.width, 1);
        const height = Math.max(box.height, track.box.height, 1);
        const distance = Math.hypot((centerX(box) - expectedX) / width, (centerY(box) - expectedY) / height);
        if (distance < bestDistance && distance <= 2.5) { best = track; bestDistance = distance; }
      }
      if (best) {
        const elapsed = time - best.seenAt;
        if (elapsed > 0.001) {
          best.vx = clamp((centerX(box) - centerX(best.box)) / elapsed, 4 * box.width);
          best.vy = clamp((centerY(box) - centerY(best.box)) / elapsed, 4 * box.height);
          best.previousBox = best.box;
          best.previousAt = best.seenAt;
        }
        best.box = { ...box };
        best.seenAt = time;
        matched.add(best);
      } else {
        const track = { box: { ...box }, seenAt: time, previousBox: null, previousAt: -Infinity, vx: 0, vy: 0 };
        this.tracks.push(track);
        matched.add(track);
      }
    }

    return this.tracks.flatMap((track) => {
      const age = Math.max(0, time - track.seenAt);
      const covers = [{ ...track.box }];
      if (track.previousBox && time - track.previousAt <= this.holdSeconds && !sameBox(track.box, track.previousBox))
        covers.push({ ...track.previousBox });
      if (age > 0) {
        const predictionTime = Math.min(age, this.maxPredictionSeconds);
        const predicted = { ...track.box, originX: track.box.originX + track.vx * predictionTime, originY: track.box.originY + track.vy * predictionTime };
        if (!covers.some((box) => sameBox(box, predicted))) covers.push(predicted);
      }
      return covers;
    });
  }
}
