import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";

const KEY = "taskradar.agent.width";
const DEFAULT = 420;
const subscribe = (notify: () => void) => { window.addEventListener("resize", notify); return () => window.removeEventListener("resize", notify); };
const snapshot = () => window.innerWidth;
function initialWidth(): number {
  try { const n = Number(localStorage.getItem(KEY)); return n >= 320 && n <= 900 ? n : DEFAULT; } catch { return DEFAULT; }
}

export function useAgentPanelWidth(wide: boolean) {
  const viewport = useSyncExternalStore(subscribe, snapshot, () => 1280);
  const [preferred, setPreferred] = useState(initialWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maximum = wide ? Math.max(320, Math.min(900, viewport - 640)) : Math.min(900, viewport);
  const minimum = Math.min(320, maximum);
  const width = Math.max(minimum, Math.min(maximum, preferred));
  const set = (next: number) => {
    const result = Math.round(Math.max(minimum, Math.min(maximum, next)));
    setPreferred(result);
    try { localStorage.setItem(KEY, String(result)); } catch { /* optional preference */ }
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    set(event.key === "Home" ? minimum : event.key === "End" ? maximum : width + (event.key === "ArrowLeft" ? 24 : -24));
  };
  return { width, resizing, minimum, maximum, handle: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width };
      setResizing(true);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => { if (drag.current) set(drag.current.width + drag.current.x - event.clientX); },
    onPointerUp: finish, onPointerCancel: finish,
    onLostPointerCapture: () => { drag.current = null; setResizing(false); },
    onKeyDown, onDoubleClick: () => set(DEFAULT),
  } };
}
