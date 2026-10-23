import { CalendarChevronsRight, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { api } from "@/lib/api";
import { addDays, formatDate, nextWeekStart, todayIn } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction } from "@/lib/queries";

const option =
  "flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:bg-accent active:bg-accent-strong disabled:pointer-events-none disabled:opacity-45";

/** A day to move to, and the control it was chosen with (that one shows the spinner). */
interface Target {
  day: string;
  via: "tomorrow" | "nextWeek" | "date";
}

/**
 * "Reschedule" for a selection of tasks, when plans change: tomorrow, next week or a chosen day for all of them at
 * once. A time of day stays as it was; the toast offers to undo the move.
 */
export function RescheduleMenu({ ids, disabled = false, onDone }: { ids: string[]; disabled?: boolean; onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const today = todayIn(timezone);
  const label = (day: string) => formatDate(day, i18n.language, Number(today.slice(0, 4)));
  // "Next week" is its Monday; the menu shows the dates, so nobody has to guess.
  const targets = [
    ["tomorrow", addDays(today, 1)],
    ["nextWeek", nextWeekStart(today)],
  ] as const;

  const move = useAction(({ day }: Target) => api.rescheduleTasks(ids, day), {
    success: (r) => {
      const closed = r.skipped.filter((s) => s.reason === "closed").length;
      const parts = [
        r.count ? t("reschedule.done", { count: r.count, date: label(r.due_date) }) : null,
        r.count || r.skipped.length ? null : t("reschedule.unchanged", { date: label(r.due_date) }),
        closed ? t("reschedule.closedKept", { count: closed }) : null,
        r.calendar_outdated.length ? t("reschedule.calendarOutdated", { count: r.calendar_outdated.length }) : null,
      ];
      return parts.filter(Boolean).join(" ") || null;
    },
    undo: (r) => r.undo_event_ids,
    onSuccess: (r) => {
      // 02:30 in the night the clocks change: those tasks keep their day, and the user sets them one by one.
      const clocks = r.skipped.filter((s) => s.reason !== "closed");
      if (clocks.length) {
        const values = { count: clocks.length, title: clocks[0].title, date: label(r.due_date) };
        toast.warning(t(clocks.length === 1 ? "reschedule.timeKeptOne" : "reschedule.timeKept", values), { duration: 10_000 });
      }
      setOpen(false);
      setDate("");
      onDone?.();
    },
  });

  const busy = (via: Target["via"]) => move.isPending && move.variables?.via === via;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (date && !move.isPending) move.mutate({ day: date, via: "date" });
  };
  const title = t("reschedule.title", { count: ids.length });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDate("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || ids.length === 0}>
          <CalendarChevronsRight /> {t("reschedule.button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-72 p-1" aria-label={title}>
        <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{title}</p>
        {targets.map(([via, day]) => (
          <button
            key={via}
            type="button"
            className={option}
            disabled={move.isPending}
            aria-busy={busy(via) || undefined}
            onClick={() => move.mutate({ day, via })}
          >
            {t(`reschedule.${via}`)}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {busy(via) ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
              {label(day)}
            </span>
          </button>
        ))}
        <form onSubmit={submit} className="mt-1 grid gap-1.5 border-t px-2 pt-2.5 pb-2">
          <label htmlFor="reschedule-date" className="text-xs font-medium text-muted-foreground">
            {t("reschedule.pickDate")}
          </label>
          <div className="flex gap-2">
            <Input id="reschedule-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-w-0 flex-1" />
            <Button type="submit" size="sm" disabled={!date || move.isPending} loading={busy("date")}>
              {t("reschedule.apply")}
            </Button>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">{t("reschedule.keepsTime")}</p>
        </form>
      </PopoverContent>
    </Popover>
  );
}
