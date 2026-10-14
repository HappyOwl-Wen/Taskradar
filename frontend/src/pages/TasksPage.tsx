import { ArrowDownUp, Ban, Check, CircleCheck, Filter, Hourglass, ListTodo, Plus, RotateCcw, Search, X } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { StatusMenu } from "@/components/tasks/StatusMenu";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { TaskRow } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/form";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { translateKey } from "@/i18n";
import { api, type TaskQuery } from "@/lib/api";
import { useAction, useTasks } from "@/lib/queries";
import { CATEGORIES, URGENCIES } from "@/lib/types";

const VIEWS = {
  active: ["confirmed", "in_progress", "waiting_for_reply"],
  candidate: ["candidate"],
  completed: ["completed"],
  dismissed: ["dismissed"],
  all: [] as string[],
} as const;
type View = keyof typeof VIEWS;
const SORTS = ["due", "urgency", "priority", "confidence", "updated_at", "detected_at"] as const;
type Sort = (typeof SORTS)[number];
const SOURCE_KINDS = ["gmail", "demo_mail", "upload", "folder", "manual"];

function MultiFilter({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={values.length ? "secondary" : "outline"} size="sm">
          <Filter />
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

export default function TasksPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const view = (params.get("view") as View) in VIEWS ? (params.get("view") as View) : "active";
  const q = params.get("q") ?? "";
  const categories = params.getAll("category");
  const urgencies = params.getAll("urgency");
  const sourceKinds = params.getAll("source_kind");
  const sort: Sort = SORTS.includes(params.get("sort") as Sort) ? (params.get("sort") as Sort) : "due";
  const order = sort === "updated_at" || sort === "detected_at" || sort === "confidence" ? "desc" : "asc";

  const update = (changes: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      if (Array.isArray(value)) value.forEach((v) => next.append(key, v));
      else if (value) next.set(key, value);
    }
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  // Query keys are hashed by value, so a fresh object per render does not refetch.
  const query: TaskQuery = {
    status: [...VIEWS[view]],
    q: q || undefined,
    category: categories,
    urgency: urgencies,
    source_kind: sourceKinds,
    sort,
    order,
    limit: 300,
  };
  const { data, error, isLoading, isFetching, refetch } = useTasks(query);
  const items = data?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  const batch = useAction((action: string) => api.batch(chosen, action), {
    success: (r) => t("tasks.batchDone", { count: r.count }),
    onSuccess: () => setSelected(new Set()),
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = items.length > 0 && chosen.length === items.length ? true : chosen.length ? "indeterminate" : false;
  const filtered = Boolean(q || categories.length || urgencies.length || sourceKinds.length);

  return (
    <div className="grid gap-5">
      <PageHeader
        title={t("tasks.title")}
        description={t("tasks.description")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> {t("tasks.new")}
          </Button>
        }
      />

      <div className="grid gap-3">
        <Tabs value={view} onValueChange={(v) => update({ view: v === "active" ? null : v })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(VIEWS) as View[]).map((v) => (
              <TabsTrigger key={v} value={v}>
                {t(`tasks.views.${v}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => update({ q: e.target.value || null })}
              placeholder={t("tasks.searchPlaceholder")}
              aria-label={t("tasks.searchPlaceholder")}
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
          <div className="flex items-center gap-1.5">
            <ArrowDownUp className="size-4 text-muted-foreground" aria-hidden />
            <SimpleSelect
              className="h-8 w-auto"
              value={sort}
              onValueChange={(v) => update({ sort: v === "due" ? null : v })}
              ariaLabel={t("common.sort")}
              options={SORTS.map((s) => ({ value: s, label: t(`tasks.sortOptions.${s}`) }))}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-1.5">
        <Checkbox
          checked={allChecked}
          onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
          aria-label={t("common.all")}
          disabled={items.length === 0}
        />
        {chosen.length ? (
          <>
            <span className="text-sm">{t("common.selected", { count: chosen.length })}</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {view === "candidate" ? (
                <Button size="xs" onClick={() => batch.mutate("confirm")} disabled={batch.isPending}>
                  <Check /> {t("statusAction.confirm")}
                </Button>
              ) : null}
              <Button variant="outline" size="xs" onClick={() => batch.mutate("complete")} disabled={batch.isPending}>
                <CircleCheck /> {t("statusAction.complete")}
              </Button>
              <Button variant="outline" size="xs" onClick={() => batch.mutate("waiting_for_reply")} disabled={batch.isPending}>
                <Hourglass /> {t("statusAction.waiting_for_reply")}
              </Button>
              <Button variant="outline" size="xs" onClick={() => batch.mutate("dismiss")} disabled={batch.isPending}>
                <Ban /> {t("statusAction.dismiss")}
              </Button>
              {view === "dismissed" || view === "completed" ? (
                <Button variant="outline" size="xs" onClick={() => batch.mutate("restore")} disabled={batch.isPending}>
                  <RotateCcw /> {t("statusAction.restore")}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("tasks.count", { count: data?.total ?? 0 })}
            {isFetching && !isLoading ? " …" : ""}
          </span>
        )}
      </div>

      {isLoading ? <LoadingRows rows={6} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {!isLoading && !error && items.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title={t("tasks.empty")}
          description={t("tasks.emptyHint")}
          action={
            filtered ? (
              <Button variant="outline" size="sm" onClick={() => update({ q: null, category: [], urgency: [], source_kind: [] })}>
                <X /> {t("common.reset")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> {t("tasks.new")}
              </Button>
            )
          }
        />
      ) : null}
      <div className="grid gap-2">
        {items.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            showStatus={view === "all"}
            selected={selected.has(task.id)}
            onSelectedChange={(on) => toggle(task.id, on)}
            actions={<StatusMenu taskId={task.id} status={task.status} size="xs" />}
          />
        ))}
      </div>

      <TaskEditDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
