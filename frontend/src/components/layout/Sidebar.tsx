import { CalendarDays, Hourglass, LayoutDashboard, ListTodo, Menu, PenLine, Settings, Timer, Trash2, type LucideIcon } from "lucide-react";
import { Link, useLocation, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import { useMediaQuery } from "@/lib/hooks";
import { taskScope, useNavMode } from "@/lib/navigation";
import { useDashboard } from "@/lib/queries";
import { formatClock, isActive, isRunning, useLiveTimers } from "@/lib/timers";
import { cn } from "@/lib/utils";
import { SidebarWeek } from "./SidebarWeek";

interface NavItem {
  to: string;
  key: "dashboard" | "allTasks" | "mine" | "calendar" | "workbench" | "focus" | "countdowns" | "settings" | "trash";
  icon: LucideIcon;
  isActive: (location: Location) => boolean;
}

// Today first; then the tasks by where they come from (all of them, the user's own, the ones in Google Calendar);
// then the timers.
const NAV: { group: "main" | "tasks" | "focus"; items: NavItem[] }[] = [
  { group: "main", items: [{ to: "/", key: "dashboard", icon: LayoutDashboard, isActive: (l) => l.pathname === "/" },
    { to: "/calendar", key: "workbench", icon: CalendarDays, isActive: (l) => l.pathname === "/calendar" }] },
  {
    group: "tasks",
    items: [
      { to: "/tasks", key: "allTasks", icon: ListTodo, isActive: (l) => taskScope(l) === "all" },
      { to: "/tasks?scope=mine", key: "mine", icon: PenLine, isActive: (l) => taskScope(l) === "mine" },
      { to: "/tasks?scope=calendar", key: "calendar", icon: CalendarDays, isActive: (l) => taskScope(l) === "calendar" },
      { to: "/trash", key: "trash", icon: Trash2, isActive: (l) => l.pathname === "/trash" },
    ],
  },
  {
    group: "focus",
    items: [
      { to: "/focus", key: "focus", icon: Timer, isActive: (l) => l.pathname.startsWith("/focus") },
      { to: "/timers", key: "countdowns", icon: Hourglass, isActive: (l) => l.pathname.startsWith("/timers") },
    ],
  },
];

/** A running timer beside its entry: the time left, coloured by what runs (focus, a break), grey when paused. */
interface LiveTime {
  text: string;
  tone: "focus" | "break" | "paused";
}

const LIVE_TONE: Record<LiveTime["tone"], { text: string; dot: string }> = {
  focus: { text: "text-primary", dot: "bg-primary" },
  break: { text: "text-success", dot: "bg-success" },
  paused: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
};
const SETTINGS: NavItem = { to: "/settings", key: "settings", icon: Settings, isActive: (l) => l.pathname.startsWith("/settings") };

/** The radar mark of the app icon (frontend/public/favicon.svg). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn("size-7 shrink-0", className)}>
      <rect width="32" height="32" rx="10" fill="#a98be2" />
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
    <div className="sidebar-brand flex min-w-0 items-center gap-2.5">
      <BrandMark />
      <div className="grid min-w-0 leading-tight">
        <span className="truncate font-display text-[15px] font-semibold tracking-tight">TaskRadar</span>
        <span className="truncate text-[11px] text-muted-foreground">{t("app.tagline")}</span>
      </div>
    </div>
  );
}

/** The number next to "Today": what is overdue (red). */
function NavCount({ value, rail }: { value: number; rail?: boolean }) {
  if (value <= 0) return null;
  return (
    <span
      className={cn(
        "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] leading-none font-semibold tabular-nums",
        rail ? "bg-overdue text-on-status" : "bg-overdue/12 text-overdue",
        rail && "absolute -top-1.5 left-[calc(50%+2px)] ring-2 ring-frame group-aria-[current=page]/nav:ring-card dark:group-aria-[current=page]/nav:ring-frame",
      )}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

function NavEntry({
  item,
  rail,
  count,
  live,
  onNavigate,
}: {
  item: NavItem;
  rail: boolean;
  count?: number;
  live?: LiveTime | null;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const Icon = item.icon;
  const current = item.isActive(location);
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(
        "sidebar-entry group/nav relative flex text-muted-foreground outline-none transition-[color,background-color,box-shadow] duration-(--duration-normal) hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent-strong",
        rail ? "h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] leading-tight font-medium" : "h-11 items-center gap-3 px-3 text-sm font-medium",
      )}
    >
      <span className="sidebar-icon relative">
        <Icon className="size-[18px]" />
        {rail && count !== undefined ? <NavCount value={count} rail /> : null}
        {rail && live ? (
          <span
            aria-hidden
            className={cn("absolute -top-0.5 -right-1 size-2 rounded-full ring-2 ring-frame", LIVE_TONE[live.tone].dot)}
          />
        ) : null}
      </span>
      <span className={cn("min-w-0 truncate", rail ? "max-w-full" : "flex-1")}>{item.key === "workbench" ? t("workbench.nav") : t(`nav.${item.key}`)}</span>
      {!rail && count !== undefined ? <NavCount value={count} /> : null}
      {live ? (
        <span className={cn("text-xs font-semibold tabular-nums", rail ? "sr-only" : LIVE_TONE[live.tone].text)}>
          {live.tone === "paused" ? t("timers.pausedShort", { time: live.text }) : live.text}
        </span>
      ) : null}
    </Link>
  );
}

/** What the timer entries show: the Pomodoro phase's time left, and the countdown that ends first. */
function useLiveTimes(lang: string): Partial<Record<NavItem["key"], LiveTime | null>> {
  const { data, remaining } = useLiveTimers();
  if (!data) return {};
  const pomodoro = data.pomodoro.current;
  const countdown = data.countdowns.find(isRunning) ?? data.countdowns.find(isActive);
  return {
    focus: isActive(pomodoro)
      ? {
          text: formatClock(remaining(pomodoro), lang),
          tone: pomodoro.status === "paused" ? "paused" : pomodoro.phase === "focus" ? "focus" : "break",
        }
      : null,
    countdowns: countdown
      ? { text: formatClock(remaining(countdown), lang), tone: countdown.status === "paused" ? "paused" : "focus" }
      : null,
  };
}

export function SidebarNav({ onNavigate, rail = false }: { onNavigate?: () => void; rail?: boolean }) {
  const { t, i18n } = useTranslation();
  const { data } = useDashboard();
  const overdue = data?.counts.overdue ?? 0;
  const live = useLiveTimes(i18n.language);
  return (
    <nav aria-label={t("nav.mainNav")} className={cn("grid", rail ? "gap-1" : "gap-0.5")}>
      {NAV.map(({ group, items }) => (
        <div key={group} role="group" aria-label={group === "main" ? undefined : t(`nav.group.${group}`)} className={cn("grid", rail ? "gap-1" : "gap-0.5")}>
          {group !== "main" ? (
            rail ? (
              <div aria-hidden className="mx-3 my-1 border-t" />
            ) : (
              <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">{t(`nav.group.${group}`)}</p>
            )
          ) : null}
          {items.map((item) => (
            <NavEntry
              key={item.key}
              item={item}
              rail={rail}
              count={item.key === "dashboard" ? overdue : undefined}
              live={live[item.key]}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Settings, at the foot of the navigation (as in Windows 11 apps). */
export function SettingsNav({ onNavigate, rail = false }: { onNavigate?: () => void; rail?: boolean }) {
  return <NavEntry item={SETTINGS} rail={rail} onNavigate={onNavigate} />;
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
      data-selection-scope="navigation"
      className={cn(
        "app-sidebar hidden h-full shrink-0 flex-col overflow-x-hidden overflow-y-auto pb-3 transition-[width] duration-(--duration-slow) ease-(--ease-move) md:flex",
        rail ? "w-[76px] px-2" : "w-[244px] px-3",
      )}
    >
      <div className={cn("sidebar-brand-row flex h-16 shrink-0 items-center", rail ? "justify-center" : "gap-1")}>
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
        {!rail ? <SidebarWeek /> : null}
        <SettingsNav rail={rail} />
      </div>
    </aside>
  );
}
