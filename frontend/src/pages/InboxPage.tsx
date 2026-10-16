import { ArrowLeft, Ban, Check, ChevronDown, ChevronUp, CircleCheckBig, FlaskConical, Inbox, ListChecks, X } from "lucide-react";
import { Fragment, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { TaskDetailView } from "@/components/tasks/TaskDetailView";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Switch } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/lib/hooks";
import { useAction, useDecisionQueue } from "@/lib/queries";
import { taskIssues, type InboxSort } from "@/lib/review";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const SORTS: InboxSort[] = ["priority", "due", "detected"];
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "j", "k"]);
const PAGE = 500;

function itemControlId(id: string): string {
  return `inbox-item-${id}`;
}

/**
 * The review queue: new tasks to confirm, and confirmed tasks with an open suggestion (a changed date,
 * a possible duplicate, "possibly done") in one list, each with what needs deciding. On wide screens the
 * list and the selected task stand side by side; below 1280 px they take turns, so the task keeps enough
 * room for its evidence and actions.
 */
export default function InboxPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery("(min-width: 1280px)");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const sortParam = params.get("sort") as InboxSort | null;
  const sort: InboxSort = sortParam && SORTS.includes(sortParam) ? sortParam : "priority";
  const onlyIssues = params.get("issues") === "1";
  const { items: queue, data, error, isLoading, isFetching, refetch } = useDecisionQueue(sort, limit);
  const items = useMemo(
    () => (onlyIssues ? queue.filter((task) => taskIssues(task).length > 0 || task.pending_suggestions > 0) : queue),
    [queue, onlyIssues],
  );
  const firstSample = items.findIndex((task) => task.sample);
  const sampleCount = items.length - (firstSample < 0 ? items.length : firstSample);
  const realCount = queue.filter((task) => !task.sample).length;
  const ids = new Set(items.map((i) => i.id));
  // Batch decisions are for new tasks (confirm or dismiss); suggestions are decided one by one.
  const selectable = items.filter((i) => i.status === "candidate");
  const chosen = [...selected].filter((id) => ids.has(id));
  const requested = params.get("task");
  // A decided task leaves the list; on wide screens the first remaining one is shown.
  const activeId = requested && ids.has(requested) ? requested : wide ? items[0]?.id : undefined;
  const showDetail = Boolean(activeId) && (wide || Boolean(requested && ids.has(requested)));
  const activeIndex = activeId ? items.findIndex((i) => i.id === activeId) : -1;
  // The position is counted among real tasks (as the header count is), or among test data for test data.
  const activeTask = activeIndex >= 0 ? items[activeIndex] : undefined;
  const peers = activeTask ? items.filter((i) => i.sample === activeTask.sample) : [];
  const peerIndex = activeTask ? peers.indexOf(activeTask) : -1;
  const loaded = data?.items.length ?? 0;
  const total = data?.total ?? loaded;

  const setParam = (changes: Record<string, string | null>, push = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: !push });
  };
  const open = (id: string) => setParam({ task: id }, !wide);
  const backToList = () => setParam({ task: null });
  const focusItem = (id: string) => window.requestAnimationFrame(() => document.getElementById(itemControlId(id))?.focus());
  const goTo = (task: TaskSummary | undefined) => {
    if (!task) return;
    setParam({ task: task.id });
    if (wide) focusItem(task.id);
  };
  // After a decision the next task in the list is shown (not the top of the list), with the focus on it.
  const afterDecision = () => {
    const next = items[activeIndex + 1] ?? items[activeIndex - 1];
    if (next) goTo(next);
    else backToList();
  };

  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const confirmBatch = useAction(() => api.batch(chosen, "confirm"), {
    success: (r) => t("inbox.confirmed", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: endSelection,
  });
  const dismissBatch = useAction(() => api.batch(chosen, "dismiss"), {
    success: (r) => t("inbox.dismissed", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: endSelection,
  });
  const batchBusy = confirmBatch.isPending || dismissBatch.isPending;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = selectable.length > 0 && chosen.length === selectable.length ? true : chosen.length > 0 ? "indeterminate" : false;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (!NAV_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
    const next = items[Math.min(items.length - 1, Math.max(0, index + step))];
    if (!next) return;
    if (wide) setParam({ task: next.id });
    document.getElementById(itemControlId(next.id))?.focus();
  };

  const list = (
    <div className={cn("flex min-h-0 flex-col border-r bg-card xl:w-[380px] 2xl:w-[420px]", showDetail && !wide ? "hidden" : "flex-1 xl:flex-none")}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-1.5">
        {selecting ? (
          <>
            <Checkbox
              checked={allChecked}
              onCheckedChange={(v) => setSelected(v === true ? new Set(selectable.map((i) => i.id)) : new Set())}
              aria-label={t("inbox.selectAll")}
              disabled={selectable.length === 0}
            />
            <span className="text-[13px]">{chosen.length ? t("common.selected", { count: chosen.length }) : t("inbox.selectHint")}</span>
            <div className="ml-auto flex gap-1">
              {chosen.length ? (
                <>
                  <Button size="sm" onClick={() => confirmBatch.mutate(undefined)} disabled={batchBusy}>
                    <Check /> {t("inbox.confirmSelected")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => dismissBatch.mutate(undefined)} disabled={batchBusy}>
                    <Ban /> {t("inbox.dismissSelected")}
                  </Button>
                </>
              ) : null}
              <Button variant="ghost" size="icon-xs" onClick={endSelection} aria-label={t("tasks.endSelection")}>
                <X />
              </Button>
            </div>
          </>
        ) : (
          <>
            <Label className="text-[13px] font-normal text-muted-foreground">
              <Switch checked={onlyIssues} onCheckedChange={(on) => setParam({ issues: on ? "1" : null })} />
              {t("inbox.onlyIssues")}
            </Label>
            <div className="ml-auto flex items-center gap-1">
              <SimpleSelect
                className="h-7 w-auto text-[13px]"
                value={sort}
                onValueChange={(v) => setParam({ sort: v === "priority" ? null : v })}
                ariaLabel={t("common.sort")}
                options={SORTS.map((s) => ({ value: s, label: t(`inbox.sort.${s}`) }))}
              />
              {selectable.length > 1 ? (
                <Button variant="ghost" size="icon-sm" onClick={() => setSelecting(true)} aria-label={t("tasks.selectMany")} className="text-muted-foreground">
                  <ListChecks />
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="scroll-stable min-h-0 flex-1 overflow-y-auto p-1.5">
        {isLoading ? <LoadingRows rows={6} className="p-1.5" /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} className="m-1.5" /> : null}
        {!isLoading && !error && items.length === 0 ? (
          onlyIssues && queue.length > 0 ? (
            <EmptyState
              compact
              icon={CircleCheckBig}
              title={t("inbox.noIssues")}
              className="m-1.5"
              action={
                <Button variant="outline" size="sm" onClick={() => setParam({ issues: null })}>
                  {t("inbox.showAll")}
                </Button>
              }
            />
          ) : (
            <EmptyState compact icon={Inbox} title={t("inbox.empty")} description={t("inbox.emptyHint")} className="m-1.5" />
          )
        ) : null}
        <ul className="grid gap-0.5" aria-label={t("inbox.listLabel")}>
          {items.map((task, index) => (
            <Fragment key={task.id}>
              {index === firstSample ? (
                <li role="presentation" className="mt-2 flex items-center gap-1.5 border-t px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                  <FlaskConical className="size-3.5" aria-hidden /> {t("sample.inboxGroup")}
                  <span className="font-normal tabular-nums">{sampleCount}</span>
                </li>
              ) : null}
              <li>
                <TaskListItem
                  task={task}
                  controlId={itemControlId(task.id)}
                  active={task.id === activeId && showDetail}
                  selected={selecting ? selected.has(task.id) : undefined}
                  onSelectedChange={selecting && task.status === "candidate" ? (on) => toggle(task.id, on) : undefined}
                  onSelect={() => open(task.id)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                  hideSample
                />
              </li>
            </Fragment>
          ))}
        </ul>
        {total > loaded ? (
          <div className="grid justify-items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            {t("tasks.countPartial", { shown: loaded, count: total })}
            <Button variant="outline" size="xs" onClick={() => setLimit((n) => n + PAGE)} disabled={isFetching}>
              {t("common.showMore")}
            </Button>
          </div>
        ) : null}
      </div>
      {items.length > 1 ? <p className="hidden shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground xl:block">{t("inbox.keyboardHint")}</p> : null}
    </div>
  );

  const detail =
    showDetail && activeId ? (
      <div className="scroll-stable min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[60rem] px-4 py-4 sm:px-8 sm:py-5">
          {/* Where am I in the queue, and the way back or on (also without a keyboard). */}
          <div className="mb-3 flex items-center gap-1 pointer-coarse:gap-3">
            {!wide ? (
              <Button variant="ghost" size="sm" className="touch-target relative -ml-2" onClick={backToList}>
                <ArrowLeft /> {t("inbox.backToList")}
              </Button>
            ) : null}
            <span className="ml-auto pr-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {peerIndex >= 0 ? t("inbox.position", { index: peerIndex + 1, count: peers.length }) : null}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="touch-target relative"
              onClick={() => goTo(items[activeIndex - 1])}
              disabled={activeIndex <= 0}
              aria-label={t("inbox.previous")}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="touch-target relative"
              onClick={() => goTo(items[activeIndex + 1])}
              disabled={activeIndex < 0 || activeIndex >= items.length - 1}
              aria-label={t("inbox.next")}
            >
              <ChevronDown />
            </Button>
          </div>
          <TaskDetailView key={activeId} taskId={activeId} embedded onDeleted={afterDecision} onDecided={afterDecision} />
        </div>
      </div>
    ) : wide ? (
      <div className="hidden flex-1 items-center justify-center p-6 xl:flex">
        {!isLoading && items.length === 0 && !onlyIssues ? (
          <EmptyState
            icon={CircleCheckBig}
            title={t("inbox.allDone")}
            description={t("inbox.allDoneHint")}
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/tasks">{t("inbox.toTasks")}</Link>
              </Button>
            }
            className="border-none"
          />
        ) : null}
      </div>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-page font-semibold">
            {t("inbox.title")} <span className="text-base font-normal text-muted-foreground tabular-nums">{realCount}</span>
          </h1>
          <p className="text-[13px] text-muted-foreground">{t("inbox.description")}</p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {list}
        {detail}
      </div>
    </div>
  );
}
