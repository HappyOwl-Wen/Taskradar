import { Tag, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import type { Category, Priority, TaskStatus, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CATEGORY_ICON, SOURCE_ICON, STATUS_ICON, URGENCY_TONE } from "./meta";

const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  candidate: "violet",
  confirmed: "primary",
  in_progress: "upcoming",
  waiting_for_reply: "high",
  completed: "success",
  dismissed: "normal",
};

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

export function CategoryBadge({ category, className }: { category: Category; className?: string }) {
  const { t } = useTranslation();
  const Icon = CATEGORY_ICON[category] ?? Tag;
  return (
    <Badge tone="outline" className={className}>
      <Icon />
      {t(`category.${category}`)}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  if (priority !== "high") return null;
  return <Badge tone="urgent">{t("priority.high")}</Badge>;
}

export function SourceKinds({ kinds, count }: { kinds: string[]; count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  const labels = kinds.map((k) => translateKey(`sourceKind.${k}`, k)).join(" · ");
  return (
    <Tip content={`${t("common.sources")}: ${labels || count}`}>
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {kinds.slice(0, 3).map((k) => {
          const Icon = SOURCE_ICON[k] ?? Tag;
          return <Icon key={k} className="size-3.5" aria-hidden />;
        })}
        {count > 1 ? <span className="tabular-nums">×{count}</span> : null}
      </span>
    </Tip>
  );
}

export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const { t } = useTranslation();
  const pct = Math.round(value * 100);
  const tone = value >= 0.8 ? "bg-success" : value >= 0.6 ? "bg-high" : "bg-overdue";
  return (
    <Tip content={`${t("common.confidence")} ${pct}%`}>
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums", className)}>
        <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${pct}%` }} />
        </span>
        {pct}%
      </span>
    </Tip>
  );
}

export function ReviewFlag({ reasons }: { reasons: string[] }) {
  const { t } = useTranslation();
  if (reasons.length === 0) return null;
  const text = reasons.map((r) => translateKey(`reviewReason.${r}`, r)).join("、");
  return (
    <Tip content={text}>
      <Badge tone="high">
        <TriangleAlert />
        {reasons.length === 1 ? translateKey(`reviewReason.${reasons[0]}`, reasons[0]) : t("inbox.needsReviewOnly")}
      </Badge>
    </Tip>
  );
}

export function ReviewReasonList({ reasons }: { reasons: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {reasons.map((r) => (
        <li key={r}>
          <Badge tone="high">
            <TriangleAlert />
            {translateKey(`reviewReason.${r}`, r)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
