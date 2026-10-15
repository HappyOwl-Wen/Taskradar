import { RadioGroup as RadioPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import type { DueChoice as Choice } from "@/lib/api";
import { formatDue } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Due = Pick<TaskSummary, "due_date" | "due_time">;

/**
 * When two tasks are merged and their deadlines differ, the user picks the date that stays.
 * Nothing is preselected unless the kept task has no deadline at all.
 */
export function DueChoicePicker({
  existing,
  incoming,
  value,
  onChange,
  disabled,
}: {
  /** The task that is kept. */
  existing: Due;
  /** The task that is merged into it. */
  incoming: Due;
  value: Choice | null;
  onChange: (value: Choice) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const year = new Date().getFullYear();
  const options: { value: Choice; title: string; date: string }[] = [
    {
      value: "existing",
      title: t("compare.keepExistingDate"),
      date: formatDue(existing, i18n.language, year) ?? t("compare.noDeadlineKept"),
    },
    { value: "new", title: t("compare.useNewDate"), date: formatDue(incoming, i18n.language, year) ?? t("due.none") },
  ];
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{t("compare.chooseDate")}</legend>
      <RadioPrimitive.Root
        value={value ?? ""}
        onValueChange={(v) => onChange(v as Choice)}
        className="grid gap-2 sm:grid-cols-2"
        aria-label={t("compare.chooseDate")}
      >
        {options.map((o) => (
          <RadioPrimitive.Item
            key={o.value}
            value={o.value}
            className={cn(
              "grid gap-0.5 rounded-lg border bg-card px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50",
              "data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 data-[state=checked]:shadow-[inset_0_0_0_1px_var(--primary)]",
            )}
          >
            <span className="text-xs text-muted-foreground">{o.title}</span>
            <span className="text-sm font-medium">{o.date}</span>
          </RadioPrimitive.Item>
        ))}
      </RadioPrimitive.Root>
    </fieldset>
  );
}
