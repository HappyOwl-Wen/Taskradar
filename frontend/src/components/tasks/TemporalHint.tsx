import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import type { QuickParse, TemporalCandidate } from "@/lib/types";

/** Compact help next to the existing date fields. No uncertain value is silently applied. */
export function TemporalHint({ result, unavailable, overridden, onConfirm }: {
  result: QuickParse | null;
  unavailable: boolean;
  overridden: boolean;
  onConfirm: (candidate: TemporalCandidate) => void;
}) {
  const { t, i18n } = useTranslation();
  const temporal = result?.temporal;
  const notes = temporal?.explanation ?? [];
  const reasons: Record<string, string> = {
    exaggerated_modifier: t("newTask.reasonExaggerated"),
    next_weekday_ambiguous: t("newTask.reasonWeekday"),
    date_order_ambiguous: t("newTask.reasonDateOrder"),
    missing_year_past: t("newTask.reasonYear"),
    leap_year_inferred: t("newTask.reasonYear"),
    past: t("newTask.reasonPast"),
    conditional: t("newTask.reasonConditional"),
    multiple_dates: t("newTask.reasonMultiple"),
    multiple_weekdays_in_range: t("newTask.reasonMultiple"),
    daypart_only: t("newTask.reasonDaypart"),
    date_range: t("newTask.reasonRange"),
    approximate: t("newTask.reasonApproximate"),
    weekdays_only: t("newTask.reasonBusiness"),
    invalid_date_or_time: t("newTask.reasonInvalid"),
    nonexistent_time: t("newTask.reasonDST"),
    ambiguous_time: t("newTask.reasonDST"),
    unknown_anchor: t("newTask.reasonAnchor"),
    unrecognized: t("newTask.reasonUnknown"),
    unsupported_timezone: t("newTask.reasonZone"),
    urgency_only: t("newTask.reasonUrgency"),
    semantic_candidate: t("newTask.reasonApproximate"),
  };
  if (overridden) return null;
  if (unavailable) return <p role="status" className="text-xs text-muted-foreground">{t("newTask.parseUnavailable")}</p>;
  const messages = [...new Set(notes.map((note) => reasons[note]).filter(Boolean))].slice(0, 2);
  const uncertain = temporal?.needs_confirmation ?? result?.ambiguous;
  if (!messages.length && !uncertain) return null;
  return (
    <div role="status" className="grid gap-1 text-xs text-muted-foreground">
      {messages.map((message) => <p key={message}>{message}</p>)}
      {uncertain ? <p>{t("newTask.confirmHint")}</p> : null}
      {uncertain ? temporal?.candidates.slice(0, 4).map((candidate, index) => {
        const date = candidate.normalized_date;
        if (!date) return candidate.range_start && candidate.range_end ? (
          <p key={index}>{t("newTask.rangeHint", { start: formatDate(candidate.range_start, i18n.language), end: formatDate(candidate.range_end, i18n.language) })}</p>
        ) : null;
        const when = `${formatDate(date, i18n.language)}${candidate.normalized_time ? ` ${candidate.normalized_time}` : ""}`;
        return candidate.selectable ? (
          <Button key={index} type="button" size="xs" variant="link" className="h-auto w-fit whitespace-normal p-0 text-left" onClick={() => onConfirm(candidate)}>
            {t("newTask.useCandidate", { when })}
          </Button>
        ) : null;
      }) : null}
    </div>
  );
}
