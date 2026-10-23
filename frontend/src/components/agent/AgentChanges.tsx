import { AlertTriangle, CalendarDays, Check, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { translateKey } from "@/i18n";
import type { AgentChange, AgentTurn } from "@/lib/agent";
import { cn } from "@/lib/utils";

const OMIT = new Set(["task_id", "block_id", "event_id", "start_fold", "end_fold", "operation"]);

function showValue(key: string, value: unknown): string {
  if (value === null) return translateKey("agent.clear", "Clear");
  if (typeof value === "boolean") return translateKey(value ? "common.yes" : "common.no", value ? "Yes" : "No");
  if (["status", "priority", "category"].includes(key)) return translateKey(`${key}.${String(value)}`, String(value));
  if (key === "time_semantics") return translateKey(`form.kind.${String(value)}`, String(value));
  if (key === "operation") return translateKey(`agent.operations.${String(value)}`, String(value));
  if (key === "buffer" && value && typeof value === "object") {
    const buffer = value as { before_minutes?: number; after_minutes?: number };
    return `${buffer.before_minutes ?? 0} / ${buffer.after_minutes ?? 0} min`;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ChangeDetails({ change }: { change: AgentChange }) {
  const { t } = useTranslation();
  const details = { ...(change.payload.changes ?? change.payload.event ?? change.payload) as Record<string, unknown>, ...(change.payload.calendar_id ? { calendar_id: change.payload.calendar_id } : {}) };
  const fields = Object.entries(details).filter(([key]) => !OMIT.has(key));
  return (
    <div className="grid gap-2">
      <dl className="grid gap-1.5 text-xs">
        {change.payload.operation ? <div className="grid grid-cols-[4.5rem_1fr] gap-2"><dt className="text-muted-foreground">{t("agent.fields.operation")}</dt><dd>{showValue("operation", change.payload.operation)}</dd></div> : null}
        {fields.map(([key, value]) => (
          <div key={key} className="grid grid-cols-[4.5rem_1fr] gap-2">
            <dt className="text-muted-foreground">{translateKey(`agent.fields.${key}`, key)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">
              {showValue(key, value)}
              {change.before && key in change.before && change.before[key] !== value ? <span className="mt-0.5 block text-muted-foreground">{t("agent.changedFrom", { value: showValue(key, change.before[key]) })}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {change.conflicts?.conflicts.length ? (
        <div className="rounded-md bg-urgent/10 p-2 text-xs text-urgent">
          <p className="flex gap-1.5 font-medium"><AlertTriangle className="size-3.5 shrink-0" />{t("agent.conflicts", { count: change.conflicts.conflicts.length })}</p>
          <ul className="mt-1 list-inside list-disc">{change.conflicts.conflicts.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
        </div>
      ) : null}
      {change.conflicts?.unchecked.length ? <p className="text-xs leading-relaxed text-urgent">{t("agent.unchecked")}</p> : null}
      {(change.result?.calendar_outdated || change.before?.calendar_outdated) ? <p className="text-xs leading-relaxed text-urgent">{t("agent.calendarOutdated")}</p> : null}
      {change.error ? <p role="alert" className="text-xs leading-relaxed text-destructive">{translateKey(`agent.errors.${change.error}`, translateKey(`errors.${change.error}`, change.error))}</p> : null}
    </div>
  );
}

export function AgentChanges({ turn, busy, applying, onApply, onDiscard }: {
  turn: AgentTurn; busy: boolean; applying: boolean; onApply: () => void; onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const pending = turn.changes.some((change) => change.status === "pending" || change.status === "error");
  const failed = turn.changes.some((change) => change.status === "error");
  return (
    <section aria-label={t("agent.proposal", { count: turn.changes.length })} className="mt-3 grid gap-3 rounded-lg border bg-card p-3">
      <header className="grid gap-1">
        <h3 className="text-[13px] font-semibold">{t("agent.proposal", { count: turn.changes.length })}</h3>
        {pending ? <p className="text-xs text-muted-foreground">{t("agent.previewHint")}</p> : null}
      </header>
      <div className="grid gap-2">
        {turn.changes.map((change) => {
          const task = change.kind.includes("task");
          const Icon = task ? ListTodo : CalendarDays;
          return (
            <details key={change.id} open={change.status === "pending" || change.status === "error"} className="rounded-md border bg-background p-2.5">
              <summary className="cursor-pointer text-xs marker:text-muted-foreground">
                <span className="ml-1 inline-flex max-w-[90%] items-center gap-1.5 align-middle"><Icon className="size-3.5 shrink-0 text-primary" /><span className="truncate font-medium">{change.title}</span></span>
                <span className={cn("mt-1 flex items-center gap-1 pl-4 text-[11px]", change.status === "applied" ? "text-success" : change.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                  {change.status === "applied" ? <Check className="size-3" /> : null}
                  {t(`agent.kind.${change.kind}`)} · {t(`agent.${change.status === "error" ? "failed" : change.status}`)}
                </span>
              </summary>
              <div className="mt-2 border-t pt-2"><ChangeDetails change={change} /></div>
              {change.status === "applied" ? <Link className="mt-2 inline-block text-xs text-primary hover:underline" to={task && change.kind !== "delete_task" && change.result?.task_id ? `/tasks/${change.result.task_id}` : "/calendar"}>{task && change.kind !== "delete_task" ? t("agent.viewTask") : t("agent.viewCalendar")}</Link> : null}
            </details>
          );
        })}
      </div>
      {failed ? <p className="text-xs leading-relaxed text-destructive">{t("agent.partial")}</p> : null}
      {pending ? <div className="grid gap-1.5">
        <Button size="sm" onClick={onApply} disabled={busy} loading={applying}>{failed ? t("agent.retryApply") : t("agent.apply")}</Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>{t("agent.discard")}</Button>
      </div> : null}
    </section>
  );
}
