export interface SelectionBox { x: number; y: number; width: number; height: number }
export const SELECTION_DURATION = 240;

/** Two compositor keyframes; easing is monotonic, without overshoot or a per-frame JavaScript loop. */
export function selectionFrames(from: SelectionBox, to: SelectionBox): Keyframe[] {
  return [
    { offset: 0, transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(${from.width / Math.max(to.width, 1)}, ${from.height / Math.max(to.height, 1)})` },
    { offset: 1, transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(1, 1)` },
  ];
}
