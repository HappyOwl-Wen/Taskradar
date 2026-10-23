import { CalendarCheck, CalendarClock, Info, TriangleAlert } from "lucide-react";
import { DateTime } from "luxon";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Conflict, useConflicts } from "@/lib/buffers";
import { formatList } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * What a planned time runs into, worded as a warning: saving stays possible. A stale answer (while the times
 * are still being typed) stays readable but faded, and its suggested slot cannot be applied.
 */
export function ConflictNotice({ check, enabled, timezone, day, onMove }: {
  check: ReturnType<typeof useConflicts>; enabled: boolean; timezone: string; day: string; onMove: (start: string, end: string) => void;
}) {
  const { t, i18n } = useTranslation();
  if (!enabled) return null;
  const { data, current, failed } = check;
  const span = (start: string, end: string) => {
    const a = DateTime.fromISO(start).setZone(timezone).setLocale(i18n.language), b = DateTime.fromISO(end).setZone(timezone).setLocale(i18n.language);
    return `${a.toISODate() === day ? "" : `${a.toFormat("D")} `}${a.toFormat("HH:mm")}–${b.toFormat("HH:mm")}`;
  };
  const detail = (conflict: Conflict) => {
    const reserved = conflict.buffer;
    if (!reserved) return t("workbench.conflictOverlap", { minutes: conflict.minutes });
    if (reserved.owner === "both") return t("workbench.conflictBoth", { minutes: conflict.minutes });
    const buffer = t(reserved.side === "before" ? "workbench.bufferPhraseBefore" : "workbench.bufferPhraseAfter", { kind: t(`workbench.kindInline_${reserved.kind}`) });
    return t(reserved.owner === "other" ? "workbench.conflictTheirs" : "workbench.conflictMine", { buffer, minutes: conflict.minutes });
  };
  const origin = (conflict: Conflict) => conflict.kind === "work" ? t("workbench.work") : conflict.kind === "appointment" ? `${t("workbench.appointment")} · ${t("workbench.appointmentAssumed")}` : conflict.source_name;
  const unchecked = data?.unchecked.length ? <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{t("workbench.unchecked", { names: formatList(data.unchecked, i18n.language) })}</p> : null;
  if (!data) {
    return <p role="status" className="text-xs text-muted-foreground">{failed ? t("workbench.checkFailed") : t("workbench.checking")}</p>;
  }
  if (!data.conflicts.length) {
    return <div role="status" className={cn("grid gap-1", !current && "opacity-60")}>
      {data.unchecked.length ? null : <p className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarCheck className="size-3.5 text-success" aria-hidden />{t("workbench.noConflict")}</p>}
      {unchecked}
    </div>;
  }
  const suggestion = data.suggestion;
  return <section role="status" aria-label={t("workbench.conflictTitle")} className={cn("grid gap-2 rounded-md border border-high/50 bg-high/5 p-3 text-sm transition-opacity", !current && "opacity-60")}>
    <p className="flex items-center gap-2 font-medium"><TriangleAlert className="size-4 shrink-0 text-high" aria-hidden />{t("workbench.conflictTitle")}</p>
    <p className="text-xs">{t("workbench.conflictIntro", { count: data.conflicts.length })}</p>
    <ul className="grid gap-1.5">
      {data.conflicts.map((conflict) => <li key={conflict.id} className="grid gap-0.5 border-l-2 pl-2" style={{ borderColor: conflict.color || "var(--border)" }}>
        <span className="font-medium break-words">{conflict.title || t("workbench.untitled")}</span>
        <span className="text-xs text-muted-foreground">{span(conflict.start, conflict.end)} · {origin(conflict)}</span>
        <span className={cn("text-xs", conflict.type === "overlap" ? "font-medium text-high" : "text-foreground")}>{detail(conflict)}</span>
      </li>)}
    </ul>
    {unchecked}
    {suggestion ? <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="xs" variant="outline" disabled={!current} onClick={() => onMove(suggestion.start, suggestion.end)}>
        <CalendarClock />{t("workbench.moveTo", { range: span(suggestion.start, suggestion.end) })}
      </Button>
      <span className="text-xs text-muted-foreground">{t("workbench.moveHint")}</span>
    </div> : null}
  </section>;
}
