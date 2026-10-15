import { Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import type { Issue } from "@/lib/review";
import type { Category, Priority, TaskStatus, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CATEGORY_ICON, ISSUE_ICON, SOURCE_ICON, STATUS_ICON, STATUS_TONE, URGENCY_TONE } from "./meta";

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
export function CategoryBadge({ category, className }: { category: Category; className?: string }) {
  const { t } = useTranslation();
  const Icon = CATEGORY_ICON[category] ?? Tag;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground", className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`category.${category}`)}
    </span>
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

const SEVERITY_TONE: Record<Issue["severity"], BadgeTone> = { high: "high", medium: "high", low: "normal" };

/** A problem in plain language ("疑似重复", "内容待核实"); the hint explains it on hover. */
export function IssueBadge({ issue, className }: { issue: Issue; className?: string }) {
  const { t } = useTranslation();
  const Icon = ISSUE_ICON[issue.kind];
  return (
    <Tip content={t(`issue.${issue.kind}.hint`)}>
      <Badge tone={issue.kind === "date_conflict" ? "overdue" : SEVERITY_TONE[issue.severity]} className={className}>
        <Icon />
        {t(`issue.${issue.kind}.label`)}
      </Badge>
    </Tip>
  );
}

/** At most one issue in a list row (the most important), plus how many more there are. */
export function IssueSummary({ issues }: { issues: Issue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  const rest = issues.slice(1).map((i) => t(`issue.${i.kind}.label`));
  return (
    <span className="inline-flex items-center gap-1">
      <IssueBadge issue={issues[0]} />
      {rest.length ? (
        <Tip content={rest.join("、")}>
          <span className="text-xs text-muted-foreground tabular-nums">+{rest.length}</span>
        </Tip>
      ) : null}
    </span>
  );
}
