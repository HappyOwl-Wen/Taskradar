import { FilePlus2, Inbox, LayoutDashboard, ListTodo, Menu, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import { useMediaQuery } from "@/lib/hooks";
import { useNavMode } from "@/lib/navigation";
import { useDashboard, useWaitingCount } from "@/lib/queries";
import { cn } from "@/lib/utils";

// What the user does, in that order: see today, decide, work through the list, add something.
// Diagnostics (run history, processing figures) are reached from Settings and the system status.
const NAV = [
  { to: "/", key: "dashboard", icon: LayoutDashboard, end: true },
  { to: "/inbox", key: "inbox", icon: Inbox, end: false },
  { to: "/tasks", key: "tasks", icon: ListTodo, end: false },
  { to: "/sources", key: "sources", icon: FilePlus2, end: false },
  { to: "/settings", key: "settings", icon: Settings, end: false },
] as const;

/** The radar mark of the app icon (frontend/public/favicon.svg). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn("size-7 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="#4f46e5" />
      <circle cx="16" cy="16" r="9" stroke="#fff" strokeOpacity=".45" strokeWidth="2" />
      <circle cx="16" cy="16" r="4.5" stroke="#fff" strokeOpacity=".75" strokeWidth="2" />
      <path d="M16 16 L23.5 9.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.8" fill="#fff" />
      <circle cx="21.5" cy="20" r="1.6" fill="#fbbf24" />
    </svg>
  );
}

export function Brand() {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BrandMark />
      <div className="grid min-w-0 leading-tight">
        <span className="truncate font-display text-[15px] font-semibold tracking-tight">TaskRadar</span>
        <span className="truncate text-[11px] text-muted-foreground">{t("app.tagline")}</span>
      </div>
    </div>
  );
}

function useNavCounts() {
  const { data } = useDashboard();
  return { inbox: useWaitingCount() ?? 0, overdue: data?.counts.overdue ?? 0 };
}

/** The number next to an entry: what waits for a decision (indigo), what is overdue (red). */
function NavCount({ value, tone, rail }: { value: number; tone: "decide" | "overdue"; rail?: boolean }) {
  if (value <= 0) return null;
  return (
    <span
      className={cn(
        "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] leading-none font-semibold tabular-nums",
        tone === "decide" ? "bg-primary text-primary-foreground" : rail ? "bg-overdue text-on-status" : "bg-overdue/12 text-overdue",
        rail && "absolute -top-1.5 left-[calc(50%+2px)] ring-2 ring-frame group-aria-[current=page]/nav:ring-card dark:group-aria-[current=page]/nav:ring-frame",
      )}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

export function SidebarNav({ onNavigate, rail = false }: { onNavigate?: () => void; rail?: boolean }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const counts = useNavCounts();
  return (
    <nav aria-label={t("nav.mainNav")} className={cn("grid", rail ? "gap-1" : "gap-0.5")}>
      {NAV.map(({ to, key, icon: Icon, end }) => {
        const count = key === "inbox" ? counts.inbox : key === "dashboard" ? counts.overdue : 0;
        const tone = key === "inbox" ? "decide" : "overdue";
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group/nav relative flex rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent-strong",
                rail
                  ? "h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] leading-tight font-medium"
                  : "h-9 items-center gap-3 px-3 text-sm font-medium",
                (isActive || (key === "settings" && pathname.startsWith("/insights"))) &&
                  "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06)] hover:bg-card dark:bg-accent-strong dark:shadow-none",
              )
            }
          >
            {({ isActive }) => {
              const current = isActive || (key === "settings" && pathname.startsWith("/insights"));
              return (
                <>
                  {/* Windows 11's selection mark: a short indigo bar at the left edge. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-full bg-primary transition-[height,opacity] duration-(--duration-normal) ease-out",
                      current ? "h-4 opacity-100" : "h-2 opacity-0",
                    )}
                  />
                  <span className="relative">
                    <Icon className={cn("size-[18px]", current && "text-primary")} />
                    {rail ? <NavCount value={count} tone={tone} rail /> : null}
                  </span>
                  <span className={cn("min-w-0 truncate", rail ? "max-w-full" : "flex-1")}>{t(`nav.${key}`)}</span>
                  {rail ? null : <NavCount value={count} tone={tone} />}
                </>
              );
            }}
          </NavLink>
        );
      })}
    </nav>
  );
}

export function AgentModeChip({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { data } = useDashboard();
  const mode = data?.agent_mode ?? "rules";
  const Icon = mode === "llm" ? Sparkles : ShieldCheck;
  const label = mode === "llm" ? t("agentMode.llm") : t("agentMode.rules");
  return (
    <Tip content={mode === "llm" ? t("agentMode.llmHint") : t("agentMode.rulesHint")} side="right">
      <NavLink
        to="/settings?section=ai"
        aria-label={compact ? label : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md text-xs text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
          compact ? "size-9 justify-center self-center" : "px-3 py-2",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", mode === "llm" ? "text-primary" : "text-success")} />
        {compact ? null : <span className="truncate">{label}</span>}
      </NavLink>
    </Tip>
  );
}

/**
 * The navigation pane, part of the window frame. Wide windows show it expanded (or as a rail, if the user prefers);
 * medium windows show the rail, whose button opens the full navigation as a drawer; on phones the top bar's menu
 * button does. Every entry keeps its name visible, also in the rail.
 */
export function Sidebar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useNavMode();
  const wide = useMediaQuery("(min-width: 1100px)");
  const rail = !wide || mode === "rail";
  const toggle = () => (wide ? setMode(rail ? "expanded" : "rail") : onOpenDrawer());
  const label = rail ? t("nav.expand") : t("nav.collapse");
  return (
    <aside
      data-mode={rail ? "rail" : "expanded"}
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-x-hidden overflow-y-auto bg-frame pb-3 transition-[width] duration-(--duration-slow) ease-(--ease-move) md:flex",
        rail ? "w-[76px] px-2" : "w-[232px] px-3",
      )}
    >
      <div className={cn("flex h-12 shrink-0 items-center", rail ? "justify-center" : "gap-1")}>
        <Tip content={label} side="right">
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            aria-expanded={!rail}
            className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent-strong"
          >
            <Menu className="size-[18px]" />
          </button>
        </Tip>
        {rail ? null : (
          <div key="brand" className="min-w-0 animate-[tr-fade-in_var(--duration-normal)_var(--ease-out)] pl-1">
            <Brand />
          </div>
        )}
      </div>
      {/* Remounted when the pane changes shape, so the entries fade into their new layout instead of jumping. */}
      <div key={rail ? "rail" : "expanded"} className="mt-2 grid animate-[tr-fade-in_var(--duration-normal)_var(--ease-out)]">
        <SidebarNav rail={rail} />
      </div>
      <div className="mt-auto grid pt-3">
        <AgentModeChip compact={rail} />
      </div>
    </aside>
  );
}
