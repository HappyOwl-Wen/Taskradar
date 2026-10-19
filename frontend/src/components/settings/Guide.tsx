import { BellRing, CalendarDays, Columns3, PanelBottomClose, Plus, Timer, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { Button } from "@/components/ui/button";
import { isDesktopApp } from "@/lib/desktop";
import { SettingsCard } from "./common";

interface Step {
  key: "add" | "board" | "remind" | "calendar" | "focus" | "tray";
  icon: LucideIcon;
  action: ReactNode;
}

/**
 * Getting started: what TaskRadar does, step by step, each with the place to do it. It lives here instead of on the
 * home page, so the home page shows only the tasks.
 */
export function GuideSection() {
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const link = (to: string, label: string) => (
    <Button variant="outline" size="xs" asChild>
      <Link to={to}>{label}</Link>
    </Button>
  );
  const steps: Step[] = [
    {
      key: "add",
      icon: Plus,
      action: (
        <Button size="xs" onClick={() => setAddOpen(true)}>
          <Plus /> {t("newTask.button")}
        </Button>
      ),
    },
    { key: "board", icon: Columns3, action: link("/", t("settings.guide.toHome")) },
    { key: "remind", icon: BellRing, action: link("/settings?section=reminders", t("settings.guide.toReminders")) },
    { key: "calendar", icon: CalendarDays, action: link("/settings?section=calendar", t("settings.guide.toCalendar")) },
    { key: "focus", icon: Timer, action: link("/focus", t("settings.guide.toFocus")) },
    ...(isDesktopApp() ? [{ key: "tray" as const, icon: PanelBottomClose, action: link("/settings?section=general", t("settings.guide.toGeneral")) }] : []),
  ];
  return (
    <SettingsCard id="guide" title={t("settings.sections.guide")} description={t("settings.guide.intro")}>
      <ol className="grid gap-2">
        {steps.map(({ key, icon: Icon, action }, i) => (
          <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md bg-card p-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{i + 1}</span>
            <div className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Icon className="size-4 text-muted-foreground" aria-hidden /> {t(`settings.guide.steps.${key}.title`)}
              </p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{t(`settings.guide.steps.${key}.hint`)}</p>
            </div>
            <div className="shrink-0 self-center">{action}</div>
          </li>
        ))}
      </ol>
      <TaskEditDialog open={addOpen} onOpenChange={setAddOpen} />
    </SettingsCard>
  );
}
