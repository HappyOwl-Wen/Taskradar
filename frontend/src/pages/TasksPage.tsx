import { ArrowDownUp, Ban, Check, CircleCheck, Ellipsis, FlaskConical, Hourglass, ListChecks, ListFilter, ListTodo, RotateCcw, ScanSearch, Search, X } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { RecheckDialog } from "@/components/tasks/RecheckDialog";
import { CompleteToggle, StatusMenu } from "@/components/tasks/StatusMenu";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/form";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { TabCount, Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { translateKey } from "@/i18n";
import { api, type TaskQuery } from "@/lib/api";
import { useAction, useDashboard, useTasks } from "@/lib/queries";
import { CATEGORIES, URGENCIES, type TaskStatus, type TaskSummary } from "@/lib/types";

const VIEWS = {
  active: ["confirmed", "in_progress", "waiting_for_reply"],
  candidate: ["candidate"],
  completed: ["completed"],
  dismissed: ["dismissed"],
  all: [] as string[],
} as const;
type View = keyof typeof VIEWS;
// The extractor's score is not a user-facing ordering; it stays out of this list.
const SORTS = ["due", "urgency", "priority", "updated_at", "detected_at"] as const;
type Sort = (typeof SORTS)[number];
const SOURCE_KINDS = ["gmail", "demo_mail", "upload", "folder", "manual"];
const PAGE = 300;

function MultiFilter({ label, values, options, onChange }: { label: string; values: string[]; options: { value: string; label: string }[]; onChange: (values: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={values.length ? "secondary" : "ghost"} size="sm" className={values.length ? "text-foreground" : "text-muted-foreground"}>
          <ListFilter />
          {label}
          {values.length ? <span className="rounded bg-primary/15 px-1 text-xs text-primary tabular-nums">{values.length}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={values.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onChange(on ? [...values, o.value] : values.filter((v) => v !== o.value))}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {values.length ? (
          <Button variant="ghost" size="xs" className="mt-1 w-full justify-start" onClick={() => onChange([])}>
            <X /> {t("common.reset")}
          </Button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The one-step action for tasks that cannot be ticked off yet: confirm a candidate, restore a dismissed task. */
function RowAction({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  const change = useAction((next: TaskStatus) => api.setStatus(task.id, next), {
    success: (r) => t(`detail.statusDone.${r.status}`, { title: r.title }),
    undo: (r) => r.undo_event_id,
  });
  if (task.status === "candidate") {
    return (
      <Button variant="outline" size="sm" className="touch-target relative" onClick={() => change.mutate("confirmed")} disabled={change.isPending} aria-label={t("taskItem.confirm", { title: task.title })}>
        <Check /> {t("statusAction.confirm")}
      </Button>
    );
  }
  if (task.status === "dismissed") {
    return (
      <Button variant="outline" size="sm" className="touch-target relative" onClick={() => change.mutate("candidate")} disabled={change.isPending} aria-label={t("taskItem.restore", { title: task.title })}>
        <RotateCcw /> {t("statusAction.restore")}
      </Button>
    );
  }
  return null;
}

export default function TasksPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const { data: dashboard } = useDashboard();

  const view = (params.get("view") as View) in VIEWS ? (params.get("view") as View) : "active";
  const q = params.get("q") ?? "";
  const categories = params.getAll("category");
  const urgencies = params.getAll("urgency");
  const sourceKinds = params.getAll("source_kind");
  // "1": only demo / test data (linked from the dashboard note); otherwise real tasks (a search finds both).
  const sampleOnly = params.get("sample") === "1";
  const focusSearch = params.get("search") === "1";
  const sort: Sort = SORTS.includes(params.get("sort") as Sort) ? (params.get("sort") as Sort) : "due";
  const order = sort === "updated_at" || sort === "detected_at" ? "desc" : "asc";

  const update = (changes: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      if (Array.isArray(value)) value.forEach((v) => next.append(key, v));
      else if (value) next.set(key, value);
    }
    setParams(next, { replace: true });
    setSelected(new Set());
    setLimit(PAGE);
  };

  // Query keys are hashed by value, so a fresh object per render does not refetch.
  const query: TaskQuery = {
    status: [...VIEWS[view]],
    q: q || undefined,
    category: categories,
    urgency: urgencies,
    source_kind: sourceKinds,
    // Lists show real tasks (as the counts do); test data has its own filter, and a search finds both.
    sample: sampleOnly ? true : q ? undefined : false,
    sort,
    order,
    limit,
  };
  const { data, error, isLoading, isFetching, refetch } = useTasks(query);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const chosen = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const batch = useAction((action: string) => api.batch(chosen, action), {
    success: (r) => t("tasks.batchDone", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: endSelection,
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const markLeaving = (id: string, on: boolean) =>
    setLeaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = items.length > 0 && chosen.length === items.length ? true : chosen.length ? "indeterminate" : false;
  const filtered = Boolean(q || categories.length || urgencies.length || sourceKinds.length || sampleOnly);
  const counts: Partial<Record<View, number>> = { active: dashboard?.counts.active, candidate: dashboard?.counts.candidates };
  const clearFilters = () => update({ q: null, category: [], urgency: [], source_kind: [], sample: null });

  return (
    <div className="grid grid-cols-1 gap-4">
      <header className="grid gap-0.5">
        <h1 className="text-page font-semibold">{t("tasks.title")}</h1>
        <p className="text-[13px] text-muted-foreground">{t("tasks.description")}</p>
      </header>

      <Tabs value={view} onValueChange={(v) => update({ view: v === "active" ? null : v })} className="min-w-0">
        <TabsList variant="underline" className="border-b">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <TabsTrigger key={v} variant="underline" value={v}>
              {t(`tasks.views.${v}`)}
              {counts[v] !== undefined ? <TabCount value={counts[v]} active={view === v} /> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => update({ q: e.target.value || null, search: null })}
            placeholder={t("tasks.searchPlaceholder")}
            aria-label={t("tasks.searchPlaceholder")}
            autoFocus={focusSearch}
            className="h-8 pl-8"
          />
        </div>
        <MultiFilter
          label={t("tasks.filterCategory")}
          values={categories}
          onChange={(v) => update({ category: v })}
          options={CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) }))}
        />
        <MultiFilter
          label={t("tasks.filterUrgency")}
          values={urgencies}
          onChange={(v) => update({ urgency: v })}
          options={URGENCIES.map((u) => ({ value: u, label: t(`urgency.${u}`) }))}
        />
        <MultiFilter
          label={t("tasks.filterSource")}
          values={sourceKinds}
          onChange={(v) => update({ source_kind: v })}
          options={SOURCE_KINDS.map((k) => ({ value: k, label: translateKey(`sourceKind.${k}`, k) }))}
        />
        {sampleOnly ? (
          <Button variant="secondary" size="sm" className="text-foreground" aria-pressed onClick={() => update({ sample: null })}>
            <FlaskConical /> {t("sample.filter")} <X className="opacity-60" />
          </Button>
        ) : null}
        {filtered ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clearFilters}>
            <X /> {t("tasks.clearFilters")}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <ArrowDownUp className="size-4 text-muted-foreground" aria-hidden />
          <SimpleSelect
            className="h-8 w-auto"
            value={sort}
            onValueChange={(v) => update({ sort: v === "due" ? null : v })}
            ariaLabel={t("common.sort")}
            options={SORTS.map((s) => ({ value: s, label: t(`tasks.sortOptions.${s}`) }))}
          />
          {/* Tools that are needed now and then: checking old tasks with the current rules, test data. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("tasks.moreTools")}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRecheckOpen(true)}>
                <ScanSearch /> {t("recheck.button")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={sampleOnly} onCheckedChange={(on) => update({ sample: on ? "1" : null })}>
                {t("tasks.onlySample")}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-3 py-1.5">
          {selecting ? (
            <>
              <Checkbox
                checked={allChecked}
                onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
                aria-label={t("inbox.selectAll")}
                disabled={items.length === 0}
              />
              <span className="text-[13px]">{chosen.length ? t("common.selected", { count: chosen.length }) : t("tasks.selectHint")}</span>
              <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                {chosen.length ? (
                  <>
                    {view === "candidate" ? (
                      <Button size="sm" onClick={() => batch.mutate("confirm")} disabled={batch.isPending}>
                        <Check /> {t("statusAction.confirm")}
                      </Button>
                    ) : null}
                    {view !== "completed" ? (
                      <Button variant="outline" size="sm" onClick={() => batch.mutate("complete")} disabled={batch.isPending}>
                        <CircleCheck /> {t("statusAction.complete")}
                      </Button>
                    ) : null}
                    {view === "active" || view === "all" ? (
                      <Button variant="outline" size="sm" onClick={() => batch.mutate("waiting_for_reply")} disabled={batch.isPending}>
                        <Hourglass /> {t("statusAction.waiting_for_reply")}
                      </Button>
                    ) : null}
                    {view !== "dismissed" ? (
                      <Button variant="outline" size="sm" onClick={() => batch.mutate("dismiss")} disabled={batch.isPending}>
                        <Ban /> {t("statusAction.dismiss")}
                      </Button>
                    ) : null}
                    {view === "dismissed" || view === "completed" ? (
                      <Button variant="outline" size="sm" onClick={() => batch.mutate("restore")} disabled={batch.isPending}>
                        <RotateCcw /> {t("statusAction.restore")}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                <Button variant="ghost" size="xs" onClick={endSelection}>
                  <X /> {t("tasks.endSelection")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="text-[13px] text-muted-foreground">
                {total > items.length ? t("tasks.countPartial", { shown: items.length, count: total }) : t("tasks.count", { count: total })}
                {isFetching && !isLoading ? " …" : ""}
              </span>
              {items.length ? (
                <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setSelecting(true)}>
                  <ListChecks /> {t("tasks.selectMany")}
                </Button>
              ) : null}
            </>
          )}
        </div>

        {isLoading ? <LoadingRows rows={6} className="p-2" /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} className="m-3" /> : null}
        {!isLoading && !error && items.length === 0 ? (
          <EmptyState
            compact
            icon={ListTodo}
            title={filtered ? t("tasks.emptyFiltered") : t(`tasks.emptyView.${view}`)}
            description={filtered ? t("tasks.emptyFilteredHint") : undefined}
            className="m-3 border-none"
            action={
              filtered ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  <X /> {t("tasks.clearFilters")}
                </Button>
              ) : view === "active" || view === "all" ? (
                <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                  <ListTodo /> {t("newTask.button")}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        <ul className="divide-y">
          {items.map((task) => (
            <li key={task.id}>
              <TaskListItem
                task={task}
                variant="row"
                selected={selecting ? selected.has(task.id) : undefined}
                onSelectedChange={selecting ? (on) => toggle(task.id, on) : undefined}
                leading={selecting ? undefined : <CompleteToggle task={task} onLeaving={(on) => markLeaving(task.id, on)} />}
                leaving={leaving.has(task.id) && view === "active"}
                actions={
                  selecting ? undefined : (
                    <>
                      <RowAction task={task} />
                      <StatusMenu taskId={task.id} status={task.status} variant="more" />
                    </>
                  )
                }
              />
            </li>
          ))}
        </ul>
        {total > items.length ? (
          <div className="flex flex-wrap items-center justify-center gap-3 border-t px-3 py-2.5 text-[13px] text-muted-foreground">
            {t("tasks.countPartial", { shown: items.length, count: total })}
            <Button variant="outline" size="xs" onClick={() => setLimit((n) => n + PAGE)} disabled={isFetching}>
              {t("common.showMore")}
            </Button>
          </div>
        ) : null}
      </div>

      <TaskEditDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RecheckDialog open={recheckOpen} onOpenChange={setRecheckOpen} />
    </div>
  );
}
