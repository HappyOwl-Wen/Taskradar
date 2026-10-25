// Development-only fixture: the same effects and CSS as the app, with controls for inspecting real animation frames.
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarDays, ListTodo, Settings, Timer } from "lucide-react";
import { LiquidGlassEffects } from "@/components/ui/LiquidGlassEffects";
import { LiquidSelectionEffects } from "@/components/ui/LiquidSelectionEffects";
import { SELECTION_DURATION } from "@/lib/liquidMotion";
import "@/index.css";

const options = [[ListTodo, "全部任务"], [CalendarDays, "我创建的"], [Timer, "Google 日历"], [Settings, "设置"]] as const;
const animations = () => document.getAnimations().filter(animation =>
  animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Element &&
  animation.effect.target.matches(".liquid-selection, .liquid-selection-refraction"));
export function Preview() {
  const [active, setActive] = useState(0), [paused, setPaused] = useState(false), [time, setTime] = useState(0);
  const [textOptics, setTextOptics] = useState(true);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (paused) for (const animation of animations()) { animation.pause(); animation.currentTime = 0; }
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [active, paused]);
  return <>
    <LiquidGlassEffects /><LiquidSelectionEffects />
    <main>
      <section className="preview-stage" aria-label="液态切换预览" data-text-optics={textOptics ? "on" : "off"}>
        <div className="preview-caption"><span>TaskRadar</span><strong>液态切换平滑收尾</strong><small>保留形变 · 折射渐退 · 字体平稳复位</small></div>
        <div className="glass-segmented preview-navigation" data-selection-scope="segmented" aria-label="预览导航">
          {options.map(([Icon, label], index) => <button key={label} type="button" aria-pressed={active === index} onClick={() => setActive(index)}><Icon /><span>{label}</span></button>)}
        </div>
      </section>
      <div className="preview-controls">
        <label><input type="checkbox" checked={textOptics} onChange={event => setTextOptics(event.target.checked)} />文字折射</label>
        <label><input type="checkbox" checked={paused} onChange={event => { setPaused(event.target.checked); if (!event.target.checked) for (const animation of animations()) animation.play(); }} />逐帧检查</label>
        <label>时间（毫秒）<input type="number" min="0" max={SELECTION_DURATION} value={time} onChange={event => { const value = Number(event.target.value); setTime(value); if (paused) for (const animation of animations()) { animation.pause(); animation.currentTime = value; } }} /></label>
        <button type="button" onClick={() => document.documentElement.classList.toggle("dark")}>切换深浅色</button>
      </div>
    </main>
    <style>{`
      body { margin:0; background:var(--background); color:var(--foreground); font-family:system-ui,sans-serif; }
      main { width:min(100%, 960px); margin:70px auto; }
      .preview-stage { position:relative; display:grid; align-content:center; gap:35px; height:320px; padding:36px 70px; border-radius:30px; overflow:hidden; background:var(--ambient) center/cover; }
      .preview-caption { display:flex; gap:15px; align-items:center; color:var(--foreground); }
      .preview-caption > span { font-family:Outfit, sans-serif; font-weight:600; color:var(--primary); }
      .preview-caption > strong { font-size:23px; letter-spacing:-.04em; }
      .preview-caption > small { margin-left:auto; color:var(--muted-foreground); }
      .preview-navigation { display:flex; width:100%; height:76px; padding:3px; gap:12px; background:var(--glass-surface); }
      .preview-navigation > button { display:flex; flex:1; height:68px; align-items:center; justify-content:center; gap:12px; border:0; border-radius:999px; background:transparent; font-size:18px; font-weight:600; color:var(--muted-foreground); cursor:pointer; }
      .preview-navigation > button[aria-pressed=true] { color:var(--primary); }
      .preview-navigation > button > svg { width:24px; height:24px; }
      .preview-stage[data-text-optics=off] .liquid-selection-refraction { visibility:hidden; }
      .preview-controls { display:flex; align-items:center; justify-content:center; gap:24px; padding:25px; font-size:14px; }
      .preview-controls label { display:flex; align-items:center; gap:10px; }
      .preview-controls input[type=number] { width:90px; border:1px solid var(--input); border-radius:8px; padding:6px 10px; }
      .preview-controls > button { border:1px solid var(--border); padding:6px 12px; border-radius:8px; }
    `}</style>
  </>;
}
// Reuse the root during Vite refreshes, retaining a single set of effect observers.
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(data => { data.root = root; });
