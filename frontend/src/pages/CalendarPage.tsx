import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import type { EventApi, EventContentArg } from "@fullcalendar/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ChevronLeft, ChevronRight, Clock3, Cloud, ExternalLink, Flag, Link2, LockKeyhole, Plus, RefreshCw } from "lucide-react";
import { DateTime } from "luxon";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ItemBuffers } from "@/components/calendar/BufferFields";
import { CalendarEditor, loadRecovery, RECOVERY_KEY, type EditorSeed } from "@/components/calendar/CalendarEditor";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { bufferBands, bufferable, bufferSummary, hasBuffer, type Band } from "@/lib/buffers";
import { calendarApi, displayRange, eventForm, visibleItems, type CalendarItem, type CalendarView } from "@/lib/calendar";
import { formatDateTime } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { refreshAll, useAction, useGoogle, useTask } from "@/lib/queries";
import "@/components/calendar/calendar.css";

const plugins = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin];
const ICONS = { deadline: Flag, work: Clock3, google: Cloud };

function ItemDetail({ item, onClose, onEdit }: { item: CalendarItem; onClose: () => void; onEdit: (s: EditorSeed) => void }) {
  const { t, i18n } = useTranslation();
  const zone = useTimezone();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resolveChoice, setResolveChoice] = useState<"local" | "remote" | null>(null);
  const remove = useAction(() => calendarApi.deleteBlock(item.work_block_id!), { onSuccess: onClose, success: t("workbench.saved") });
  const detach = useAction(() => calendarApi.detachBlock(item.work_block_id!), { onSuccess: onClose, success: t("workbench.saved") });
  const resolve = useAction(() => calendarApi.resolveTaskLink(item.task_id!, resolveChoice!, item.remote!.etag!), { onSuccess: onClose, success: t("workbench.saved") });
  const link = useAction(() => calendarApi.linkTask(item.calendar_id!, item.event_id!), { onSuccess: (r) => { onClose(); navigate(`/tasks/${r.task_id}`); } });
  const edit = () => { onClose(); onEdit({ mode: item.event_id ? "google" : "local", item }); };
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle className="break-words">{item.title}</DialogTitle><DialogDescription>{t(`workbench.${item.kind}`)} · {item.source_name === "local" ? t(item.kind === "deadline" ? "workbench.localTask" : "workbench.localOnly") : item.source_name}</DialogDescription></DialogHeader>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      <dt className="text-muted-foreground">{t("workbench.when")}</dt><dd>{displayRange(item.start, item.end, item.all_day, zone, i18n.language)}{item.due_time ? <p>{item.due_date} {item.due_time} · {item.timezone}</p> : null}</dd>
      <dt className="text-muted-foreground">{t("workbench.source")}</dt><dd>{item.source_name === "local" ? t("workbench.local") : item.source_name}<p className="text-xs text-muted-foreground">{t("workbench.readTime", { zone: item.timezone })}</p></dd>
      <dt className="text-muted-foreground">{t("workbench.status")}</dt><dd>{translateKey(`workbench.status_${item.sync_status}`, item.sync_status)}</dd>
      {item.kind !== "deadline" ? <><dt className="text-muted-foreground">{t("workbench.edit")}</dt><dd>{item.editable ? t("workbench.editable") : t("workbench.readOnly")}</dd></> : null}
    </dl>
    {bufferable(item) ? <ItemBuffers item={item} /> : null}
    {item.remote?.location ? <p className="text-sm">{t("workbench.location")}: {item.remote.location}</p> : null}
    {item.remote?.description ? <p className="max-h-40 overflow-auto text-sm whitespace-pre-wrap break-words text-muted-foreground">{item.remote.description}</p> : null}
    {item.task_status === "completed" ? <p className="flex items-center gap-2 text-sm text-success"><CheckCheck className="size-4" />{t("workbench.complete")}</p> : null}
    {item.complex ? <p className="rounded-md bg-muted p-3 text-sm">{t("workbench.complex")}</p> : null}
    {item.kind === "deadline" && item.event_id ? <p className="text-sm text-muted-foreground">{t("workbench.mapping")}</p> : null}
    {item.needs_review && item.remote ? <div className="grid gap-2 rounded-md border border-high/40 p-3 text-sm"><strong>{t("workbench.remoteChanged")}</strong><p>{item.remote.summary}</p><p>{item.remote.start?.dateTime ?? item.remote.start?.date} → {item.remote.end?.dateTime ?? item.remote.end?.date}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!item.remote.etag} onClick={() => setResolveChoice("remote")}>{t("workbench.acceptRemote")}</Button><Button size="sm" variant="outline" disabled={!item.remote.etag} onClick={() => setResolveChoice("local")}>{t("workbench.pushLocal")}</Button></div></div> : null}
    {item.kind === "work" ? <p className="text-xs text-muted-foreground">{t("workbench.deletion")}</p> : null}
    <div className="flex flex-wrap gap-2">
      {item.task_id ? <Button variant="outline" asChild><Link to={`/tasks/${item.task_id}`}><Link2 />{t("workbench.openTask")}</Link></Button> : null}
      {item.kind === "deadline" ? <Button onClick={() => { onClose(); onEdit({ mode: "local", taskId: item.task_id, title: item.title, start: `${item.start}T09:00` }); }}><Clock3 />{t("workbench.newBlock")}</Button> : null}
      {item.editable ? <Button onClick={edit}>{t("workbench.edit")}</Button> : null}
      {item.kind === "work" && !item.event_id ? <Button variant="outline" onClick={() => { onClose(); onEdit({ mode: "google", item, publish: true }); }}><Cloud />{t("workbench.publishBlock")}</Button> : null}
      {item.html_link ? <Button variant="outline" asChild><a href={item.html_link} target="_blank" rel="noopener noreferrer"><ExternalLink />{t("workbench.openGoogle")}</a></Button> : null}
      {item.kind === "google" && !item.task_id && !item.complex && !item.all_day ? <Button variant="outline" onClick={() => setImporting(true)}>{t("workbench.importTask")}</Button> : null}
      {item.work_block_id ? <Button variant="ghost" className="text-destructive" onClick={() => setDeleting(true)}>{t("workbench.deleteBlock")}</Button> : null}
      {item.work_block_id && item.event_id ? <Button variant="outline" loading={detach.isPending} onClick={() => detach.mutate(undefined)}>{t("workbench.detach")}</Button> : null}
      {item.event_id && item.editable ? <Button variant="ghost" className="text-destructive" onClick={() => { onClose(); onEdit({ mode: "google", item, operation: "delete" }); }}>{t("workbench.deleteEvent")}</Button> : null}
    </div>
    <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={t("workbench.deleteBlock")} description={<>{item.title}<br />{t("workbench.deletion")}</>} confirmLabel={t("workbench.deleteBlock")} cancelLabel={t("common.cancel")} destructive pending={remove.isPending} onConfirm={() => remove.mutate(undefined)} />
    <ConfirmDialog open={importing} onOpenChange={setImporting} title={t("workbench.importTask")} description={t("workbench.importHint")} confirmLabel={t("workbench.importTask")} cancelLabel={t("common.cancel")} pending={link.isPending} onConfirm={() => link.mutate(undefined)} />
    <ConfirmDialog open={resolveChoice !== null} onOpenChange={(open) => !open && setResolveChoice(null)} title={t(resolveChoice === "local" ? "workbench.pushLocal" : "workbench.acceptRemote")} description={<div className="grid gap-2"><p>{t("workbench.resolveHint")}</p><p>{item.title} · {item.due_date} {item.due_time}</p><p>{t("workbench.target")}: {item.source_name}</p><p>{item.remote?.summary} · {item.remote?.start?.dateTime ?? item.remote?.start?.date} → {item.remote?.end?.dateTime ?? item.remote?.end?.date}</p></div>} confirmLabel={t("workbench.submit")} cancelLabel={t("common.cancel")} pending={resolve.isPending} onConfirm={() => resolve.mutate(undefined)} />
  </DialogContent></Dialog>;
}

function Unscheduled({ data, onPlan }: { data: CalendarView; onPlan: (s: EditorSeed) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const draggable = new Draggable(ref.current, { itemSelector: "[data-task-id]", eventData: { create: false } });
    return () => draggable.destroy();
  }, []);
  return <details className="calendar-unscheduled rounded-lg border bg-subtle p-3" open={data.unscheduled.length > 0}>
    <summary className="cursor-pointer text-sm font-medium">{t("workbench.unscheduled")} · {data.unscheduled.length}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t("workbench.unscheduledHint")}</p>
    <div ref={ref} className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-auto">
      {data.unscheduled.map((task) => <div key={task.id} data-task-id={task.id} data-title={task.title} className="flex max-w-full cursor-grab items-center gap-3 rounded-md border bg-card px-3 py-1.5 text-sm">
        <span className="truncate">{task.title}</span><Button size="xs" variant="outline" aria-label={`${t("workbench.schedule")} ${task.title}`} onClick={() => onPlan({ mode: "local", taskId: task.id, title: task.title })}>{t("workbench.schedule")}</Button>
      </div>)}
      {!data.unscheduled.length ? <p className="text-xs text-muted-foreground">{t("workbench.noUnscheduled")}</p> : null}
    </div>
  </details>;
}

export default function CalendarPage() {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const task = useTask(params.get("task") ?? undefined);
  const { data: google } = useGoogle();
  const calendar = useRef<FullCalendar>(null);
  const [view, setView] = useState(() => window.innerWidth < 700 ? "listMonth" : "dayGridMonth");
  const [range, setRange] = useState({ start: "", end: "", title: "" });
  const [local, setLocal] = useState(true);
  const [completed, setCompleted] = useState(true);
  const [editor, setEditor] = useState<EditorSeed | null>(null);
  const [detail, setDetail] = useState<CalendarItem | null>(null);
  const [recovery, setRecovery] = useState(loadRecovery);
  const [syncMessage, setSyncMessage] = useState("");
  const { data, error, refetch } = useQuery({ queryKey: ["calendar-workspace", range.start, range.end, timezone], queryFn: () => calendarApi.view(range.start, range.end), enabled: !!range.start, refetchInterval: 20_000 });
  const refresh = useAction(() => calendarApi.refresh(range.start, range.end), { onSuccess: (r) => {
    setSyncMessage(r.status === "partial" ? t("workbench.partial") : r.status === "failed" ? t("workbench.refreshFailed") : "");
  } });
  const select = useAction((ids: string[]) => calendarApi.select(ids, ids.includes(data?.default_calendar_id ?? "") ? data?.default_calendar_id ?? null : null, data?.google_edit_enabled ?? false));
  const autoRefreshed = useRef("");
  const scrolledRange = useRef("");
  useEffect(() => {
    if (view !== "timeGridWeek" || !data) return;
    const key = `${view}/${range.start}`;
    if (scrolledRange.current === key) return;
    scrolledRange.current = key;
    const frame = requestAnimationFrame(() => calendar.current?.getApi().scrollToTime("08:00:00"));
    return () => cancelAnimationFrame(frame);
  }, [view, range.start, data]);
  useEffect(() => {
    if (!range.start || !google?.calendar.connected) return;
    const key = `${range.start}/${range.end}/${timezone}`;
    if (autoRefreshed.current === key) return;
    autoRefreshed.current = key;
    void calendarApi.refresh(range.start, range.end).then((r) => {
      if (r.status === "partial" || r.status === "failed") setSyncMessage(t("workbench.refreshFailed"));
      void refreshAll(qc);
    }).catch(() => setSyncMessage(t("workbench.refreshFailed")));
  }, [range.start, range.end, timezone, google?.calendar.connected, qc, t]);
  const openedTask = useRef("");
  useEffect(() => {
    if (!task.data || !data || params.get("plan") !== "1" || openedTask.current === task.data.id) return;
    openedTask.current = task.data.id;
    setEditor({ mode: "local", taskId: task.data.id, title: task.data.title });
  }, [task.data, data, params]);
  const closeEditor = () => { setEditor(null); setRecovery(loadRecovery()); if (params.has("plan")) setParams({}); };
  const openEditor = (s: EditorSeed) => setEditor({ ...s, id: s.id ?? s.draft?.id ?? crypto.randomUUID() });
  const changeView = (next: string) => { setView(next); calendar.current?.getApi().changeView(next); };
  const changeTime = (event: EventApi, revert: () => void) => {
    const item = data?.items.find((i) => i.id === event.id);
    const a = event.startStr, b = event.endStr;
    revert();
    if (!item || !b) return;
    const form = eventForm(item, timezone);
    const allDay = event.allDay;
    if (item.kind === "work" && allDay) return;
    openEditor({ mode: item.event_id ? "google" : "local", item, form: { ...form, all_day: allDay,
      start: DateTime.fromISO(a, { zone: timezone }).toFormat(allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm"),
      end: DateTime.fromISO(b, { zone: timezone }).toFormat(allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm") } });
  };
  const shown = data ? visibleItems(data, local).filter((item) => completed || item.task_status !== "completed") : [];
  const events = [...shown.map((item) => ({
    id: item.id, title: item.title, start: item.start, end: item.end, allDay: item.all_day,
    editable: item.editable && item.kind !== "deadline", backgroundColor: item.color, borderColor: item.color,
    classNames: [`calendar-${item.kind}`, item.task_status === "completed" ? "calendar-completed" : ""], extendedProps: { item },
  })), ...(view === "timeGridWeek" ? bufferBands(shown) : [])];
  const bandLabel = (band: Band) => t("workbench.bufferBand", { kind: t(`workbench.kind_${band.kind}`), minutes: band.minutes });
  const renderEvent = ({ event, timeText }: EventContentArg) => {
    const band = event.extendedProps.band as Band | undefined;
    if (band) return <span className="calendar-buffer-label">{bandLabel(band)}</span>;
    const item = event.extendedProps.item as CalendarItem;
    const Icon = ICONS[item.kind];
    const time = view === "dayGridMonth" ? timeText.split(" - ")[0] : timeText;
    return <span className="calendar-event-content"><Icon size={12} aria-hidden /><span className="calendar-event-text"><span className="calendar-event-title">{time ? `${time} ` : ""}{event.title}{item.due_time ? ` · ${item.due_time}` : ""}</span><small>{t(`workbench.${item.kind}`)} · {item.source_name === "local" ? t(item.kind === "deadline" ? "workbench.localTask" : "workbench.localOnly") : item.source_name}{item.editable || item.kind === "deadline" ? "" : ` · ${t("workbench.readOnly")}`}{hasBuffer(item.buffer) ? ` · ${bufferSummary(t, item.buffer)}` : ""}</small></span>{!item.editable && item.kind !== "deadline" ? <LockKeyhole size={11} aria-hidden /> : null}</span>;
  };
  return <div className="calendar-workspace grid gap-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-page font-semibold">{t("workbench.title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("workbench.subtitle")}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => openEditor({ mode: "local" })}><Clock3 />{t("workbench.newBlock")}</Button><Button onClick={() => openEditor({ mode: "google" })} disabled={!data?.sources.some((s) => s.writable)}><Plus />{t("workbench.newEvent")}</Button></div>
    </header>
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-subtle p-2">
      <Button variant="outline" onClick={() => calendar.current?.getApi().today()}>{t("workbench.today")}</Button>
      <Button variant="ghost" size="icon" aria-label={t("workbench.prev")} onClick={() => calendar.current?.getApi().prev()}><ChevronLeft /></Button>
      <Button variant="ghost" size="icon" aria-label={t("workbench.next")} onClick={() => calendar.current?.getApi().next()}><ChevronRight /></Button>
      <h2 className="mr-auto min-w-36 text-base font-semibold" aria-live="polite">{range.title}</h2>
      <Input type="date" aria-label={t("workbench.jump")} className="w-37" value={params.get("date") ?? undefined} onChange={(e) => { if (e.target.value) calendar.current?.getApi().gotoDate(e.target.value); }} />
      <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label={t("workbench.title")}>
        {([["dayGridMonth", "month"], ["timeGridWeek", "week"], ["listMonth", "agenda"]] as const).map(([v, key]) => <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} aria-pressed={view === v} onClick={() => changeView(v)}>{t(`workbench.${key}`)}</Button>)}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label={t("workbench.sources")}>
      <label className="flex items-center gap-2"><input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /><Flag className="size-4 text-high" />{t("workbench.local")}</label>
      {data?.sources.map((s) => <label key={s.id} className="flex max-w-full items-center gap-2" title={s.app_created ? t("workbench.own") : t("workbench.other")}>
        <input type="checkbox" checked={s.selected} disabled={select.isPending} onChange={(e) => select.mutate(data.sources.filter((x) => x.id === s.id ? e.target.checked : x.selected).map((x) => x.id))} />
        <Cloud className="size-4 shrink-0" style={{ color: s.color }} /><span className="truncate">{s.summary}</span>{s.writable ? null : <LockKeyhole className="size-3" aria-label={t("workbench.readOnly")} />}
      </label>)}
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />{t("workbench.showCompleted")}</label>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
      <span>{t("workbench.timezone")}: {timezone}</span><span aria-hidden>·</span>
      <span>{data?.capabilities.connected ? t("workbench.cached") : t("workbench.offline")}</span>
      <Button variant="ghost" size="xs" onClick={() => refresh.mutate(undefined)} loading={refresh.isPending} disabled={!range.start || !google?.calendar.connected}><RefreshCw />{t("workbench.refresh")}</Button>
      <Link className="text-primary hover:underline" to="/settings?section=calendar">{t("workbench.settings")}</Link>
    </div>
    {data?.sources.some((s) => s.selected) ? <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{data.sources.filter((s) => s.selected).map((s) => <span key={s.id}>{s.summary} · {data.window_updated[s.id] ? t("workbench.updated", { time: formatDateTime(data.window_updated[s.id], i18n.language, timezone) }) : t("workbench.never")}{s.last_error ? ` · ${translateKey(`errors.${s.last_error}`, s.last_error)}` : ""}</span>)}</div> : null}
    {syncMessage ? <p role="status" className="rounded-md border border-high/30 bg-high/5 p-3 text-sm">{syncMessage}</p> : null}
    {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
    <div className="calendar-canvas overflow-hidden rounded-lg border">
      <FullCalendar ref={calendar} plugins={plugins} initialView={view} initialDate={params.get("date") ?? undefined} locale={i18n.language === "zh-CN" ? zhLocale : "en"}
        timeZone={timezone} headerToolbar={false} height={view === "timeGridWeek" ? 500 : "auto"} firstDay={1} fixedWeekCount={false} nowIndicator allDaySlot
        dayMaxEvents={3} eventMaxStack={3} eventDisplay="block" slotMinTime="00:00:00" slotMaxTime="24:00:00" scrollTime="08:00:00"
        slotDuration="00:30:00" displayEventEnd eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        allDayText={t("workbench.allDay")} noEventsText={t("workbench.empty")} events={events} eventContent={renderEvent}
        eventClick={(info) => { info.jsEvent.preventDefault(); setDetail(info.event.extendedProps.item as CalendarItem); }}
        datesSet={(info) => setRange({ start: info.startStr.slice(0, 10), end: info.endStr.slice(0, 10), title: info.view.title })}
        eventDidMount={({ el, event }) => {
          const band = event.extendedProps.band as Band | undefined;
          // Reserved time is drawn behind its item; the item itself (and its detail) carries it for keyboards and readers.
          if (band) { const owner = event.extendedProps.item as CalendarItem; el.style.setProperty("--band", owner.color); el.title = `${bandLabel(band)} · ${owner.title}`; el.setAttribute("aria-hidden", "true"); return; }
          el.setAttribute("tabindex", "0"); el.setAttribute("role", "button"); el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const current = calendar.current?.getApi().getEventById(event.id); if (current) setDetail(current.extendedProps.item as CalendarItem); } }); }}
        selectable selectMirror select={(info) => { calendar.current?.getApi().unselect(); openEditor({ mode: "local", start: `${info.startStr.slice(0, 10)}T${info.allDay ? "09:00" : info.startStr.slice(11, 16)}`, form: !info.allDay ? { ...eventForm(undefined, timezone, info.startStr), end: DateTime.fromISO(info.endStr, { zone: timezone }).toFormat("yyyy-MM-dd'T'HH:mm") } : undefined }); }}
        editable eventDrop={(info) => changeTime(info.event, info.revert)} eventResize={(info) => changeTime(info.event, info.revert)}
        droppable drop={(info) => openEditor({ mode: "local", taskId: info.draggedEl.dataset.taskId, title: info.draggedEl.dataset.title, start: info.allDay ? `${info.dateStr}T09:00` : info.dateStr })}
      />
    </div>
    {data ? <Unscheduled data={data} onPlan={openEditor} /> : null}
    {(data?.drafts.length || recovery) ? <section className="grid gap-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">{t("workbench.drafts")}</h2>
      {data?.drafts.map((d) => <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{d.payload.title} · {data.sources.find((s) => s.id === d.calendar_id)?.summary} · {t(`workbench.operation_${d.operation}`)} {d.last_error ? `· ${translateKey(`errors.${d.last_error}`, d.last_error)}` : ""}</span><Button variant="outline" size="xs" onClick={() => openEditor({ mode: "google", draft: d })}>{t("workbench.resume")}</Button></div>)}
      {recovery && !data?.drafts.some((d) => d.id === recovery.id) ? <div className="flex gap-2"><Button variant="outline" size="xs" onClick={() => openEditor(recovery)}>{t("workbench.browserDraft")}</Button><Button variant="ghost" size="xs" onClick={() => { localStorage.removeItem(RECOVERY_KEY); setRecovery(null); toast(t("workbench.discard")); }}>{t("workbench.discard")}</Button></div> : null}
    </section> : null}
    {detail ? <ItemDetail item={detail} onClose={() => setDetail(null)} onEdit={openEditor} /> : null}
    {editor && data ? <CalendarEditor key={editor.id} seed={editor} sources={data} timezone={timezone} onClose={closeEditor} /> : null}
    <p className="text-xs text-muted-foreground">{t("workbench.filtersHint")}</p>
  </div>;
}
