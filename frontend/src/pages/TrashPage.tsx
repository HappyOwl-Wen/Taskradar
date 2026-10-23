import { ArrowLeft, ArrowRight, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Input } from "@/components/ui/form";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDateTime, formatDue } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTrash } from "@/lib/queries";
import type { TrashedTask } from "@/lib/types";

const PAGE_SIZE = 100;

export default function TrashPage() {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawOffset = Number(params.get("offset"));
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const { data, error, isLoading, isFetching, refetch } = useTrash({ q: q || undefined, offset });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<TrashedTask[]>([]);
  const items = data?.items ?? [];
  const chosen = items.filter((task) => selected.has(task.id));
  const clearSelection = () => setSelected(new Set());
  const restore = useAction((ids: string[]) => api.restoreTasks(ids), {
    success: (result) => t("trash.restored", { count: result.count }),
    onSuccess: clearSelection,
  });
  const purge = useAction((ids: string[]) => api.purgeTasks(ids), {
    success: (result) => t("trash.deleted", { count: result.count }),
    onSuccess: () => {
      clearSelection();
      setDeleteTargets([]);
    },
  });
  const busy = restore.isPending || purge.isPending;
  const disabled = busy || isFetching;
  const update = (search: string, nextOffset: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (nextOffset) next.set("offset", String(nextOffset));
    setParams(next, { replace: true });
    clearSelection();
  };
  const toggle = (id: string, checked: boolean) => setSelected((previous) => {
    const next = new Set(previous);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5">
      <PageHeader title={t("trash.title")} description={t("trash.description", { days: data?.retention_days ?? 30 })} />
      <p className="rounded-lg bg-subtle px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">{t("trash.calendarHint")}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
          <Input aria-label={t("trash.search")} placeholder={t("trash.search")} value={q} disabled={busy} onChange={(event) => update(event.target.value, 0)} className="pr-9 pl-9" />
          {q ? <Button variant="ghost" size="icon-sm" aria-label={t("trash.clearSearch")} className="absolute top-0 right-0" disabled={busy} onClick={() => update("", 0)}><X /></Button> : null}
        </div>
        <span className="text-sm text-muted-foreground" role="status">{t("trash.count", { count: data?.total ?? 0 })}</span>
      </div>
      {isLoading ? <LoadingRows /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : items.length ? (
        <div className="tasks-list">
          <div className="flex min-h-12 flex-wrap items-center gap-3 border-b bg-subtle px-4 py-2">
            <Checkbox aria-label={t("trash.selectPage")} checked={chosen.length === items.length ? true : chosen.length ? "indeterminate" : false} disabled={disabled} onCheckedChange={(checked) => setSelected(checked ? new Set(items.map((task) => task.id)) : new Set())} />
            <span className="mr-auto text-[13px] text-muted-foreground">{t("common.selected", { count: chosen.length })}</span>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button size="sm" variant="outline" disabled={disabled || !chosen.length} onClick={() => restore.mutate(chosen.map((task) => task.id))}><RotateCcw />{t("trash.restoreSelected")}</Button>
              <Button size="sm" variant="ghost" className="text-destructive" disabled={disabled || !chosen.length} onClick={() => setDeleteTargets(chosen)}><Trash2 />{t("trash.deleteSelected")}</Button>
            </div>
          </div>
          <ul className="divide-y" aria-label={t("trash.title")} aria-busy={isFetching}>
            {items.map((task) => (
              <li key={task.id} className="flex items-start gap-3 px-4 py-4">
                <Checkbox className="mt-1" aria-label={t("trash.selectTask", { title: task.title })} checked={selected.has(task.id)} disabled={disabled} onCheckedChange={(checked) => toggle(task.id, checked === true)} />
                <div className="grid min-w-0 flex-1 gap-2">
                  <p className="font-medium wrap-anywhere">{task.title}</p>
                  {task.description ? <p className="line-clamp-2 whitespace-pre-line text-[13px] text-muted-foreground wrap-anywhere">{task.description}</p> : null}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("trash.previousStatus", { status: t(`status.${task.status}`) })}</span>
                    {task.due_date ? <span>{formatDue(task, i18n.language)}</span> : null}
                    <span>{t("trash.deletedAt", { time: formatDateTime(task.deleted_at, i18n.language, timezone) })}</span>
                    <span title={t("trash.expiresAt", { time: formatDateTime(task.expires_at, i18n.language, timezone) })}>{t("trash.expiresIn", { count: task.days_remaining })}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" aria-label={t("trash.restoreTask", { title: task.title })} disabled={disabled} onClick={() => restore.mutate([task.id])}><RotateCcw />{t("trash.restore")}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" aria-label={t("trash.deleteTask", { title: task.title })} disabled={disabled} onClick={() => setDeleteTargets([task])}><Trash2 />{t("trash.delete")}</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : <EmptyState icon={Trash2} title={t(q ? "trash.noResults" : offset ? "trash.noPage" : "trash.empty")} description={t(q ? "trash.noResultsHint" : "trash.emptyHint")} action={<Button variant="outline" asChild><Link to="/tasks">{t("trash.backToTasks")}</Link></Button>} />}
      {offset > 0 || (data?.total ?? 0) > PAGE_SIZE ? (
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" size="sm" disabled={disabled || offset === 0} onClick={() => update(q, Math.max(0, offset - PAGE_SIZE))}><ArrowLeft />{t("trash.previousPage")}</Button>
          <span className="text-sm text-muted-foreground">{t("common.page", { page: Math.floor(offset / PAGE_SIZE) + 1 })}</span>
          <Button variant="outline" size="sm" disabled={disabled || offset + PAGE_SIZE >= (data?.total ?? 0)} onClick={() => update(q, offset + PAGE_SIZE)}>{t("trash.nextPage")}<ArrowRight /></Button>
        </div>
      ) : null}
      <ConfirmDialog open={deleteTargets.length > 0} onOpenChange={(open) => { if (!open && !purge.isPending) setDeleteTargets([]); }} title={t("trash.deleteTitle", { count: deleteTargets.length })} description={t("trash.deleteDescription")} confirmLabel={t("trash.delete")} cancelLabel={t("common.cancel")} destructive pending={purge.isPending} onConfirm={() => purge.mutate(deleteTargets.map((task) => task.id))}>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">{deleteTargets.map((task) => <li key={task.id} className="wrap-anywhere">{task.title}</li>)}</ul>
      </ConfirmDialog>
    </div>
  );
}
