import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, CalendarPlus, CalendarX, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatMinutes, formatTime } from "@/lib/format";
import { useAction, useSystemStatus } from "@/lib/queries";
import type { CalendarPreview, TaskDetail } from "@/lib/types";

function When({ preview }: { preview: CalendarPreview }) {
  const { t, i18n } = useTranslation();
  const { start, end } = preview.event;
  if (start.date) return <span>{formatDate(start.date, i18n.language)} · {t("calendar.allDay")}</span>;
  const tz = start.timeZone ?? "Europe/Berlin";
  return (
    <span>
      {formatDateTime(start.dateTime, i18n.language, tz)} – {formatTime(end.dateTime, i18n.language, tz)} ({tz})
    </span>
  );
}

function PreviewDialog({ task, open, onOpenChange, connected }: { task: TaskDetail; open: boolean; onOpenChange: (o: boolean) => void; connected: boolean }) {
  const { t, i18n } = useTranslation();
  const preview = useQuery({ queryKey: ["calendar-preview", task.id, task.due_version, task.updated_at], queryFn: () => api.calendarPreview(task.id), enabled: open });
  const write = useAction(() => api.calendarSync(task.id), {
    success: (r) => (r.unchanged ? t("calendar.unchanged") : t("calendar.synced")),
    onSuccess: () => onOpenChange(false),
  });
  const confirmed = ["confirmed", "in_progress", "waiting_for_reply"].includes(task.status);
  const p = preview.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("calendar.previewTitle")}</DialogTitle>
          <DialogDescription>{t("calendar.previewHint")}</DialogDescription>
        </DialogHeader>
        {preview.isLoading ? <Skeleton className="h-40" /> : null}
        {preview.error ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} /> : null}
        {p ? (
          <div className="grid gap-3">
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <dt className="text-muted-foreground">{t("calendar.eventTitle")}</dt>
              <dd className="font-medium">{p.event.summary}</dd>
              <dt className="text-muted-foreground">{t("calendar.when")}</dt>
              <dd>
                <When preview={p} />
              </dd>
              <dt className="text-muted-foreground">{t("calendar.kind")}</dt>
              <dd>{t(`semantics.${task.time_semantics}`)}</dd>
              <dt className="text-muted-foreground">{t("calendar.reminder")}</dt>
              <dd>
                {p.event.reminders.overrides
                  .map((o) => t("calendar.reminderBefore", { value: formatMinutes(o.minutes, i18n.language) }))
                  .join(", ")}
              </dd>
              <dt className="text-muted-foreground">{t("calendar.calendar")}</dt>
              <dd>{p.calendar_name}</dd>
            </dl>
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/30 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {p.event.description}
            </pre>
            {p.warnings.length ? (
              <ul className="grid gap-1">
                {p.warnings.map((w) => (
                  <li key={w} className="flex items-center gap-2 text-sm text-high">
                    <TriangleAlert className="size-4" /> {translateKey(`calendar.warnings.${w}`, w)}
                  </li>
                ))}
              </ul>
            ) : null}
            {!connected ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-high/40 bg-high/10 px-3 py-2 text-sm">
                <span>{t("calendar.notConnected")}</span>
                <Button variant="outline" size="xs" asChild>
                  <Link to="/settings#calendar">{t("calendar.goToSettings")}</Link>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => write.mutate(undefined)} disabled={!p || !connected || !confirmed || write.isPending}>
            <CalendarPlus /> {t("calendar.confirmWrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Calendar integration for one task: always preview → explicit confirmation → write. */
export function CalendarCard({ task }: { task: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const { data: status } = useSystemStatus();
  const [open, setOpen] = useState(false);
  const connected = Boolean(status?.google.calendar_connected);
  const confirmed = ["confirmed", "in_progress", "waiting_for_reply"].includes(task.status);
  const link = task.calendar;
  const outdated = link && (link.status === "out_of_sync" || link.synced_due_version !== task.due_version);

  let body: React.ReactNode;
  if (!task.due_date) {
    body = <p className="text-sm text-muted-foreground">{t("calendar.noDue")}</p>;
  } else {
    body = (
      <div className="grid gap-3">
        {!connected ? (
          <div className="grid gap-2 rounded-md border border-dashed p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CalendarX className="size-4 text-muted-foreground" /> {t("calendar.notConnected")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("calendar.notConnectedHint")}</p>
            <Button variant="outline" size="xs" className="w-fit" asChild>
              <Link to="/settings#calendar">{t("calendar.goToSettings")}</Link>
            </Button>
          </div>
        ) : null}
        {connected && !confirmed ? <p className="text-sm text-muted-foreground">{t("calendar.notConfirmed")}</p> : null}
        {link ? (
          <div className="grid gap-1 text-sm">
            {link.status === "failed" ? (
              <p className="text-destructive">{t("calendar.failed", { error: translateKey(`errors.${link.last_error}`, link.last_error ?? "") })}</p>
            ) : outdated ? (
              <p className="text-high">{t("calendar.outOfSync")}</p>
            ) : (
              <p className="flex items-center gap-2 text-success">
                <CalendarCheck className="size-4" /> {t("calendar.synced")}
              </p>
            )}
            {link.last_synced_at ? <p className="text-xs text-muted-foreground">{formatDateTime(link.last_synced_at, i18n.language, task.timezone)}</p> : null}
            {link.html_link ? (
              <a href={link.html_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="size-3" /> {t("calendar.openEvent")}
              </a>
            ) : null}
          </div>
        ) : null}
        <Button variant={link && !outdated && link.status === "synced" ? "outline" : "default"} size="sm" className="w-fit" onClick={() => setOpen(true)}>
          {link ? <RefreshCw /> : <CalendarPlus />}
          {link ? t("calendar.update") : t("calendar.preview")}
        </Button>
        <PreviewDialog task={task} open={open} onOpenChange={setOpen} connected={connected} />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t("calendar.title")}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
