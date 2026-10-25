export interface SelectionBox { x: number; y: number; width: number; height: number }
export const SELECTION_DURATION = 480;
export const SELECTION_LENS_INSET = { x: 4, y: 5 } as const;

const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;
const response = (offset: number, delay: number) => {
  const end = SELECTION_DURATION / 1000 - delay;
  const t = Math.max(0, offset * SELECTION_DURATION / 1000 - delay);
  const spring = (time: number) => 1 - (1 + 25 * time) * Math.exp(-25 * time);
  return spring(t) / spring(end);
};

/** The leading edge leaves first; the trailing edge catches up like a viscous droplet. */
export function selectionBoxAt(from: SelectionBox, to: SelectionBox, offset: number, liquid = true): SelectionBox {
  if (offset <= 0) return { ...from };
  if (offset >= 1) return { ...to };
  const dx = to.x + to.width / 2 - from.x - from.width / 2;
  const dy = to.y + to.height / 2 - from.y - from.height / 2;
  const distance = Math.hypot(dx, dy);
  const lead = response(offset, 0), tail = liquid && distance > 1 ? response(offset, .065) : lead;
  const progress = (lead + tail) / 2;
  if (!liquid || distance < 1) return {
    x: mix(from.x, to.x, lead), y: mix(from.y, to.y, lead),
    width: mix(from.width, to.width, lead), height: mix(from.height, to.height, lead),
  };
  const horizontal = Math.abs(dx) >= Math.abs(dy), forward = (horizontal ? dx : dy) >= 0;
  const start = horizontal ? "x" : "y", extent = horizontal ? "width" : "height";
  let low = mix(from[start], to[start], forward ? tail : lead);
  let high = mix(from[start] + from[extent], to[start] + to[extent], forward ? lead : tail);
  // Distant sidebar destinations still form one compact droplet, rather than a full-height stripe.
  const maxExtent = Math.max(from[extent], to[extent]) * 1.7;
  if (high - low > maxExtent) {
    if (forward) low = high - maxExtent;
    else high = low + maxExtent;
  }
  const settle = Math.sin(Math.PI * Math.max(0, (offset - .6) / .4)) * Math.min(3, distance * .025);
  low += (forward ? 1 : -1) * settle; high += (forward ? 1 : -1) * settle;
  const lag = Math.min(1, Math.max(0, lead - tail) / .35);
  const arrival = Math.exp(-(((offset - .72) / .13) ** 2)) * Math.min(1, distance / 30);
  // Vertical navigation has narrow side gutters: keep its arrival bulge inside the scroll area.
  const crossScale = 1 - .12 * lag + (horizontal ? .12 : .035) * arrival;
  const crossExtent = mix(horizontal ? from.height : from.width, horizontal ? to.height : to.width, progress) * crossScale;
  const crossCentre = horizontal
    ? mix(from.y + from.height / 2, to.y + to.height / 2, progress)
    : mix(from.x + from.width / 2, to.x + to.width / 2, progress);
  return horizontal
    ? { x: low, y: crossCentre - crossExtent / 2, width: Math.max(1, high - low), height: crossExtent }
    : { x: crossCentre - crossExtent / 2, y: low, width: crossExtent, height: Math.max(1, high - low) };
}

/** Prepare the deformation once; playback uses compositor transforms, without a JS frame loop. */
export function selectionFrames(from: SelectionBox, to: SelectionBox, liquid = true): Keyframe[] {
  return Array.from({ length: 41 }, (_, index) => {
    const offset = index / 40;
    const box = selectionBoxAt(from, to, offset, liquid);
    return { offset, transform: `translate3d(${box.x}px, ${box.y}px, 0) scale(${box.width / Math.max(to.width, 1)}, ${box.height / Math.max(to.height, 1)})` };
  });
}

/** A separate, untinted foreground lens fades out before the material finishes moving. */
export function selectionRefractionFrames(frames: Keyframe[], initialOpacity = 0): Keyframe[] {
  const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
  const initial = Math.max(0, Math.min(1, initialOpacity));
  return frames.map((frame, index) => {
    const offset = index / Math.max(1, frames.length - 1);
    const entrance = initial + (1 - initial) * smooth(offset / .15);
    const exit = 1 - smooth((offset - .55) / .4);
    return { ...frame, transform: `${frame.transform} translate(${-SELECTION_LENS_INSET.x}px, ${-SELECTION_LENS_INSET.y}px)`, opacity: entrance * exit };
  });
}

/** The material carries the motion; the symbol follows with a small, single lift. */
export const selectionSymbolFrames: Keyframe[] = [
  { offset: 0, transform: "scale(1)" },
  { offset: .3, transform: "scale(1.1)" },
  { offset: .65, transform: "scale(.99)" },
  { offset: 1, transform: "scale(1)" },
];
