export interface SelectionBox { x: number; y: number; width: number; height: number }
export const SELECTION_DURATION = 580;

/** A damped spring, sampled once per interaction. The browser composites the resulting transforms. */
export function selectionFrames(from: SelectionBox, to: SelectionBox): Keyframe[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const frames: Keyframe[] = [];
  for (let step = 0; step <= 42; step++) {
    const time = step / 42, seconds = time * SELECTION_DURATION / 1000;
    const decay = 13, frequency = 19;
    let progress = 1 - Math.exp(-decay * seconds) * (Math.cos(frequency * seconds) + decay / frequency * Math.sin(frequency * seconds));
    if (progress > 1) progress = 1 + Math.min(progress - 1, 10 / Math.max(distance, 1));
    if (step === 42) progress = 1;
    const pulse = Math.sin(Math.PI * time) * Math.exp(-time * 2) * .07;
    const horizontal = distance ? Math.abs(dx) / distance : 0;
    const vertical = distance ? Math.abs(dy) / distance : 0;
    const width = from.width + (to.width - from.width) * progress;
    const height = from.height + (to.height - from.height) * progress;
    const sx = width / Math.max(to.width, 1) * (1 + pulse * (horizontal - vertical * .5));
    const sy = height / Math.max(to.height, 1) * (1 + pulse * (vertical - horizontal * .5));
    const hop = Math.sin(Math.PI * time) * Math.exp(-time * 2) * Math.min(8, distance * .025);
    const x = from.x + dx * progress - (sx * to.width - width) / 2;
    const y = from.y + dy * progress - (sy * to.height - height) / 2 - hop;
    frames.push({ offset: time, transform: `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})` });
  }
  return frames;
}
