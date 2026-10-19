import { ArrowRight, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/menu";
import { LoadingRows } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { clause, formatRelativeTime } from "@/lib/format";
import { useSystemSummary } from "@/lib/queries";
import type { StatusAction, StatusItem, StatusLevel, SystemSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_ICON: Record<StatusLevel, LucideIcon> = { error: CircleAlert, warning: TriangleAlert, info: Info };
const LEVEL_TEXT: Record<StatusLevel, string> = { error: "text-destructive", warning: "text-urgent", info: "text-muted-foreground" };

/** Where the user can fix a problem. */
const ACTION_TARGET: Record<StatusAction, string> = {
  calendar: "/settings?section=calendar",
  notifications: "/settings?section=reminders",
  tasks: "/tasks?scope=calendar",
};

function errorText(code: string, t: TFunction): string {
  return clause(translateKey(`errors.${code}`, code === "unknown" ? t("systemStatus.unknownError") : code));
}

/** Title and explanation of a status item in the user's language (codes and numbers come from the server). */
function describeStatus(item: StatusItem, t: TFunction, language: string): { title: string; hint: string } {
  const p = item.params;
  const values = {
    count: typeof p.count === "number" ? p.count : 0,
    error: typeof p.error === "string" ? errorText(p.error, t) : "",
    since: item.since ? formatRelativeTime(item.since, language) : t("systemStatus.unknownTime"),
  };
  return {
    title: translateKey(`systemStatus.item.${item.code}.title`, item.code, values),
    hint: translateKey(`systemStatus.item.${item.code}.hint`, "", values),
  };
}

export function StatusItemRow({ item, compact = false, onNavigate }: { item: StatusItem; compact?: boolean; onNavigate?: () => void }) {
  const { t, i18n } = useTranslation();
  const Icon = LEVEL_ICON[item.level];
  const { title, hint } = describeStatus(item, t, i18n.language);
  const target = item.action ? ACTION_TARGET[item.action] : undefined;
  return (
    <li className={cn("flex items-start gap-3", compact ? "py-2.5" : "px-4 py-3")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", LEVEL_TEXT[item.level])} aria-hidden />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        {hint ? <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      {target && item.action ? (
        <Button variant="outline" size="xs" asChild className="shrink-0">
          <Link to={target} onClick={onNavigate}>
            {t(`systemStatus.action.${item.action}`)}
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

function headline(summary: SystemSummary, t: TFunction): string {
  const counted = summary.items.filter((i) => i.level !== "info").length;
  if (summary.overall === "problem") return t("systemStatus.problem", { count: counted });
  if (summary.overall === "attention") return t("systemStatus.attention", { count: counted });
  return t("systemStatus.ok");
}

/**
 * The system status as one icon at the top right: a green tick while everything runs, amber or red when something
 * needs the user. A click shows what it is, in plain words, each with the place to fix it.
 */
export function SystemStatusButton() {
  const { t } = useTranslation();
  const { data, error } = useSystemSummary();
  const overall = error ? "unknown" : (data?.overall ?? "unknown");
  const Icon = overall === "ok" ? CircleCheck : overall === "problem" ? CircleAlert : overall === "attention" ? TriangleAlert : Info;
  const tone =
    overall === "ok" ? "text-success" : overall === "problem" ? "text-destructive" : overall === "attention" ? "text-urgent" : "text-muted-foreground";
  const label = data ? headline(data, t) : error ? t("systemStatus.unavailable") : t("systemStatus.checking");
  return (
    <Popover>
      <Tip content={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="touch-target relative" aria-label={`${t("systemStatus.title")}: ${label}`}>
            <Icon className={tone} />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
          <Icon className={cn("size-4", tone)} aria-hidden />
          {label}
        </p>
        {data && data.items.length ? (
          <ul className="max-h-80 divide-y overflow-y-auto px-4">
            {data.items.map((item) => (
              <StatusItemRow key={`${item.code}-${item.area}`} item={item} compact />
            ))}
          </ul>
        ) : data ? (
          <p className="px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">{t("systemStatus.okHint")}</p>
        ) : null}
        <div className="flex justify-end border-t px-2 py-1.5">
          <Button variant="ghost" size="xs" asChild>
            <Link to="/settings?section=system">
              {t("systemStatus.details")} <ArrowRight />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Settings → System: every item, including hints (info). */
export function SystemStatusList() {
  const { t } = useTranslation();
  const { data, isLoading } = useSystemSummary();
  if (isLoading) return <LoadingRows rows={2} />;
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-subtle px-4 py-3 text-sm">
        <CircleCheck className="size-4 text-success" aria-hidden /> {t("systemStatus.ok")}
        <span className="text-[13px] text-muted-foreground">· {t("systemStatus.okHint")}</span>
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {data.items.map((item) => (
        <StatusItemRow key={`${item.code}-${item.area}`} item={item} />
      ))}
    </ul>
  );
}
