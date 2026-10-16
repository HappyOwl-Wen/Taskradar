import { Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/menu";
import type { Category, Priority, TaskStatus, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { KeyState } from "./keyStates";
import { CATEGORY_ICON, STATUS_ICON, STATUS_TONE, URGENCY_TONE } from "./meta";

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      <Icon />
      {t(`status.${status}`)}
    </Badge>
  );
}

export function UrgencyBadge({ urgency, className }: { urgency: Urgency; className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={URGENCY_TONE[urgency]} className={className}>
      {t(`urgency.${urgency}`)}
    </Badge>
  );
}

/** Category as quiet text with its icon: it describes the task, it is not a warning. */
export function CategoryBadge({ category, className, iconOnly = false }: { category: Category; className?: string; iconOnly?: boolean }) {
  const { t } = useTranslation();
  const Icon = CATEGORY_ICON[category] ?? Tag;
  const label = t(`category.${category}`);
  if (iconOnly) {
    return (
      <Tip content={label}>
        <span className={cn("inline-flex text-muted-foreground", className)}>
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </span>
      </Tip>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground", className)}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  if (priority !== "high") return null;
  return <Badge tone="urgent">{t("priority.high")}</Badge>;
}

/**
 * The most important states, at most `max` of them. Further ones are not hidden behind a hover: "N more"
 * opens a small list with an explanation of each (also on touch screens).
 */
export function KeyStates({ states, max = 2 }: { states: KeyState[]; max?: number }) {
  const { t } = useTranslation();
  if (states.length === 0) return null;
  const shown = states.slice(0, max);
  const rest = states.slice(max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shown.map((s) => {
        const Icon = s.icon;
        const badge = (
          <Badge key={s.key} tone={s.tone} className="text-[13px] [&_svg]:size-3.5">
            {Icon ? <Icon /> : null}
            {s.label}
          </Badge>
        );
        return s.hint ? (
          <Tip key={s.key} content={s.hint}>
            {badge}
          </Tip>
        ) : (
          badge
        );
      })}
      {rest.length ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="touch-target relative z-10 rounded-sm text-[13px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              {t("taskItem.moreStates", { count: rest.length })}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-3">
            <ul className="grid gap-2.5">
              {rest.map((s) => {
                const Icon = s.icon;
                return (
                  <li key={s.key} className="grid gap-1">
                    <Badge tone={s.tone} className="w-fit">
                      {Icon ? <Icon /> : null}
                      {s.label}
                    </Badge>
                    {s.hint ? <p className="text-xs leading-relaxed text-muted-foreground">{s.hint}</p> : null}
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
