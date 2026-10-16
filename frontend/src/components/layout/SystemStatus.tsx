import { ArrowRight, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingRows } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { clause, formatList, formatRelativeTime } from "@/lib/format";
import { useSystemSummary } from "@/lib/queries";
import type { StatusAction, StatusItem, StatusLevel, SystemSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_ICON: Record<StatusLevel, LucideIcon> = { error: CircleAlert, warning: TriangleAlert, info: Info };
const LEVEL_TEXT: Record<StatusLevel, string> = { error: "text-destructive", warning: "text-urgent", info: "text-muted-foreground" };

/** Where the user can fix a problem. */
const ACTION_TARGET: Record<StatusAction, string> = {
  gmail_settings: "/settings?section=gmail",
  ai_settings: "/settings?section=ai",
  sources: "/sources",
  records: "/sources",
  tasks: "/tasks?view=active",
  ocr_help: "/sources",
};

function errorText(code: string, t: TFunction): string {
  return clause(translateKey(`errors.${code}`, code === "unknown" ? t("insights.unknownError") : code));
}

function reasons(codes: unknown, t: TFunction, language: string): string {
  if (typeof codes !== "object" || codes === null) return "";
  return formatList(
    Object.entries(codes as Record<string, number>).map(([code, count]) => `${errorText(code, t)}${count > 1 ? ` ×${count}` : ""}`),
    language,
  );
}

/** Title and explanation of a status item in the user's language (codes and numbers come from the server). */
function describeStatus(item: StatusItem, t: TFunction, language: string): { title: string; hint: string } {
  const p = item.params;
  const values = {
    count: typeof p.count === "number" ? p.count : 0,
    name: typeof p.name === "string" ? p.name : "",
    error: typeof p.error === "string" ? errorText(p.error, t) : "",
    reasons: reasons(p.codes, t, language),
    since: item.since ? formatRelativeTime(item.since, language) : t("systemStatus.unknownTime"),
  };
  return {
    title: translateKey(`systemStatus.item.${item.code}.title`, item.code, values),
    hint: translateKey(`systemStatus.item.${item.code}.hint`, "", values),
  };
}

export function StatusItemRow({ item, compact = false }: { item: StatusItem; compact?: boolean }) {
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
          <Link to={target}>{t(`systemStatus.action.${item.action}`)}</Link>
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
 * Dashboard: one quiet line while everything runs; when something needs the user, a card with the few
 * things to do, in plain words, each with the place to fix it.
 */
export function SystemStatusCard() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useSystemSummary();
  const notable = data?.items.filter((i) => i.level !== "info") ?? [];
  const details = (
    <Button variant="ghost" size="xs" asChild className="ml-auto">
      <Link to="/insights">
        {t("systemStatus.details")} <ArrowRight />
      </Link>
    </Button>
  );
  if (isLoading) return <LoadingRows rows={1} />;
  if (error || !data) {
    return (
      <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-[13px] text-muted-foreground">
        {t("systemStatus.unavailable")}
        {details}
      </p>
    );
  }
  if (notable.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        <span>{t("systemStatus.okLine")}</span>
        {details}
      </p>
    );
  }
  return (
    <section className="grid gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-section font-semibold">{t("systemStatus.title")}</h2>
        {details}
      </div>
      <div className="rounded-lg border bg-card px-4 py-1">
        <p className="flex items-center gap-2 py-2.5 text-sm font-medium">
          <TriangleAlert className={cn("size-4", data.overall === "problem" ? "text-destructive" : "text-urgent")} aria-hidden />
          {headline(data, t)}
        </p>
        <ul className="divide-y border-t">
          {notable.slice(0, 3).map((item) => (
            <StatusItemRow key={`${item.code}-${item.area}-${String(item.params.name ?? "")}`} item={item} compact />
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Insights: every item, including hints (info) such as a missing OCR engine. */
export function SystemStatusList() {
  const { t } = useTranslation();
  const { data, isLoading } = useSystemSummary();
  if (isLoading) return <LoadingRows rows={2} />;
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
        <CircleCheck className="size-4 text-success" aria-hidden /> {t("systemStatus.ok")}
        <span className="text-[13px] text-muted-foreground">· {t("systemStatus.okHint")}</span>
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {data.items.map((item) => (
        <StatusItemRow key={`${item.code}-${item.area}-${String(item.params.name ?? "")}`} item={item} />
      ))}
    </ul>
  );
}
