import { ChartColumn, FolderSync, Inbox, LayoutDashboard, ListTodo, Radar, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import { useDashboard } from "@/lib/queries";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", key: "dashboard", icon: LayoutDashboard, end: true },
  { to: "/inbox", key: "inbox", icon: Inbox, end: false },
  { to: "/tasks", key: "tasks", icon: ListTodo, end: false },
  { to: "/sources", key: "sources", icon: FolderSync, end: false },
  { to: "/insights", key: "insights", icon: ChartColumn, end: false },
  { to: "/settings", key: "settings", icon: Settings, end: false },
] as const;

export function Brand() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Radar className="size-[18px]" />
      </span>
      <div className="grid leading-tight">
        <span className="text-[15px] font-semibold tracking-tight">TaskRadar</span>
        <span className="text-[11px] text-muted-foreground">{t("app.tagline")}</span>
      </div>
    </div>
  );
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { data } = useDashboard();
  // Distinct tasks waiting for a decision (a candidate with an open suggestion counts once).
  const inboxCount = data ? (data.counts.needs_action ?? data.counts.candidates + data.counts.pending_suggestions) : 0;
  const overdue = data?.counts.overdue ?? 0;
  return (
    <nav aria-label={t("nav.mainNav")} className="grid gap-0.5">
      {NAV.map(({ to, key, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              isActive && "bg-accent text-foreground",
            )
          }
        >
          <Icon className="size-4" />
          <span className="flex-1">{t(`nav.${key}`)}</span>
          {key === "inbox" && inboxCount > 0 ? (
            <span className="rounded-full bg-violet/15 px-1.5 text-xs font-semibold text-violet tabular-nums">{inboxCount}</span>
          ) : null}
          {key === "dashboard" && overdue > 0 ? (
            <span className="rounded-full bg-overdue/15 px-1.5 text-xs font-semibold text-overdue tabular-nums">{overdue}</span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function AgentModeChip() {
  const { t } = useTranslation();
  const { data } = useDashboard();
  const mode = data?.agent_mode ?? "rules";
  const Icon = mode === "llm" ? Sparkles : ShieldCheck;
  return (
    <Tip content={mode === "llm" ? t("agentMode.llmHint") : t("agentMode.rulesHint")} side="right">
      <NavLink
        to="/settings?section=ai"
        className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon className={cn("size-3.5", mode === "llm" ? "text-violet" : "text-success")} />
        {mode === "llm" ? t("agentMode.llm") : t("agentMode.rules")}
      </NavLink>
    </Tip>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r bg-sidebar px-3 py-4 lg:flex">
      <Brand />
      <SidebarNav />
      <div className="mt-auto">
        <AgentModeChip />
      </div>
    </aside>
  );
}
