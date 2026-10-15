import { ArrowLeft, Ban, Check, CircleCheckBig, Inbox, Lightbulb, X } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { SuggestionCard } from "@/components/tasks/SuggestionCard";
import { TaskDetailView } from "@/components/tasks/TaskDetailView";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Switch } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/lib/hooks";
import { useAction, useSuggestions, useTasks } from "@/lib/queries";
import { sortInbox, taskIssues, type InboxSort } from "@/lib/review";
import type { Suggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

const SORTS: InboxSort[] = ["priority", "due", "detected"];
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "j", "k"]);

function itemControlId(id: string): string {
  return `inbox-item-${id}`;
}

function Candidates() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // Side by side from 1024 px; below that the list and the detail take turns.
  const wide = useMediaQuery("(min-width: 1024px)");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sortParam = params.get("sort") as InboxSort | null;
  const sort: InboxSort = sortParam && SORTS.includes(sortParam) ? sortParam : "priority";
  const onlyIssues = params.get("issues") === "1";
  const { data, error, isLoading, refetch } = useTasks({ status: ["candidate"], limit: 500 });
  const items = useMemo(() => {
    const all = data?.items ?? [];
    return sortInbox(onlyIssues ? all.filter((task) => taskIssues(task).length > 0) : all, sort);
  }, [data, onlyIssues, sort]);
  const ids = new Set(items.map((i) => i.id));
  const chosen = [...selected].filter((id) => ids.has(id));
  const requested = params.get("task");
  // A decided task leaves the list; on wide screens the first remaining one is shown.
  const activeId = requested && ids.has(requested) ? requested : wide ? items[0]?.id : undefined;
  const showDetail = Boolean(activeId) && (wide || Boolean(requested && ids.has(requested)));

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
  const afterDecision = () => {
    const i = items.findIndex((x) => x.id === activeId);
    const next = items[i + 1] ?? items[i - 1];
    if (wide && next) setParam({ task: next.id });
    else backToList();
  };

  const clear = () => setSelected(new Set());
  const confirmBatch = useAction(() => api.batch(chosen, "confirm"), {
    success: (r) => t("inbox.confirmed", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: clear,
  });
  const dismissBatch = useAction(() => api.batch(chosen, "dismiss"), {
    success: (r) => t("inbox.dismissed", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: clear,
  });
  const batchBusy = confirmBatch.isPending || dismissBatch.isPending;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = items.length > 0 && chosen.length === items.length ? true : chosen.length > 0 ? "indeterminate" : false;

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
    <div className={cn("flex min-h-0 flex-col border-r bg-background lg:w-[320px] xl:w-[380px]", showDetail && !wide ? "hidden" : "flex-1 lg:flex-none")}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-1.5">
        <Checkbox
          checked={allChecked}
          onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
          aria-label={t("inbox.selectAll")}
          disabled={items.length === 0}
        />
        {chosen.length ? (
          <>
            <span className="text-[13px]">{t("common.selected", { count: chosen.length })}</span>
            <div className="ml-auto flex gap-1">
              <Button size="xs" onClick={() => confirmBatch.mutate(undefined)} disabled={batchBusy}>
                <Check /> {t("inbox.confirmSelected")}
              </Button>
              <Button variant="outline" size="xs" onClick={() => dismissBatch.mutate(undefined)} disabled={batchBusy}>
                <Ban /> {t("inbox.dismissSelected")}
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={clear} aria-label={t("common.clearSelection")}>
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
            <SimpleSelect
              className="ml-auto h-7 w-auto text-[13px]"
              value={sort}
              onValueChange={(v) => setParam({ sort: v === "priority" ? null : v })}
              ariaLabel={t("common.sort")}
              options={SORTS.map((s) => ({ value: s, label: t(`inbox.sort.${s}`) }))}
            />
          </>
        )}
      </div>
      <div className="scroll-stable min-h-0 flex-1 overflow-y-auto p-1.5">
        {isLoading ? <LoadingRows rows={6} className="p-1.5" /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} className="m-1.5" /> : null}
        {!isLoading && !error && items.length === 0 ? (
          onlyIssues && (data?.items.length ?? 0) > 0 ? (
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
        <ul className="grid gap-0.5" aria-label={t("inbox.candidatesTab")}>
          {items.map((task, index) => (
            <li key={task.id}>
              <TaskListItem
                task={task}
                controlId={itemControlId(task.id)}
                active={task.id === activeId && showDetail}
                selected={selected.has(task.id)}
                onSelectedChange={(on) => toggle(task.id, on)}
                onSelect={() => open(task.id)}
                onKeyDown={(e) => onKeyDown(e, index)}
              />
            </li>
          ))}
        </ul>
      </div>
      {items.length > 1 ? <p className="hidden shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground lg:block">{t("inbox.keyboardHint")}</p> : null}
    </div>
  );

  const detail = showDetail && activeId ? (
    <div className="scroll-stable min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
        {!wide ? (
          <Button variant="ghost" size="sm" className="-ml-2 mb-3" onClick={backToList}>
            <ArrowLeft /> {t("inbox.backToList")}
          </Button>
        ) : null}
        <TaskDetailView key={activeId} taskId={activeId} embedded onDeleted={afterDecision} onDecided={afterDecision} />
      </div>
    </div>
  ) : wide ? (
    <div className="hidden flex-1 items-center justify-center p-6 lg:flex">
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
    <div className="flex min-h-0 flex-1">
      {list}
      {detail}
    </div>
  );
}

const KIND_ORDER: Suggestion["kind"][] = ["possible_duplicate", "update_due", "mark_completed", "mark_dismissed", "mark_waiting"];

function Suggestions() {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useSuggestions();
  const items = [...(data?.items ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return (
    <div className="scroll-stable min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl gap-3 px-4 py-5 sm:px-6">
        {isLoading ? <LoadingRows rows={3} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {!isLoading && !error && items.length === 0 ? (
          <EmptyState icon={Lightbulb} title={t("inbox.suggestionsEmpty")} description={t("inbox.suggestionsEmptyHint")} />
        ) : null}
        {items.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} />
        ))}
      </div>
    </div>
  );
}

export default function InboxPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "suggestions" ? "suggestions" : "candidates";
  const { data: candidates } = useTasks({ status: ["candidate"], limit: 500 });
  const { data: suggestions } = useSuggestions();
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setParams(v === "suggestions" ? { tab: v } : {}, { replace: true })}
      className="flex h-full flex-col"
    >
      <div className="shrink-0 border-b px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{t("inbox.title")}</h1>
          <p className="text-[13px] text-muted-foreground">{t("inbox.description")}</p>
        </div>
        <TabsList variant="underline" className="mt-2">
          <TabsTrigger variant="underline" value="candidates">
            {t("inbox.candidatesTab")} <TabCount value={candidates?.total} active={tab === "candidates"} />
          </TabsTrigger>
          <TabsTrigger variant="underline" value="suggestions">
            {t("inbox.suggestionsTab")} <TabCount value={suggestions?.items.length} active={tab === "suggestions"} />
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="candidates" className="flex min-h-0 flex-1">
        <Candidates />
      </TabsContent>
      <TabsContent value="suggestions" className="flex min-h-0 flex-1">
        <Suggestions />
      </TabsContent>
    </Tabs>
  );
}
