import { Ban, Check, Inbox, Lightbulb, MousePointerClick } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { SuggestionCard } from "@/components/tasks/SuggestionCard";
import { TaskDetailView } from "@/components/tasks/TaskDetailView";
import { TaskRow } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Switch } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/lib/hooks";
import { useAction, useSuggestions, useTasks } from "@/lib/queries";

type SortKey = "detected_at" | "due";

function Candidates() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sort, setSort] = useState<SortKey>("detected_at");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The side-by-side review panel needs room; on small screens the title links to the task page.
  const wide = useMediaQuery("(min-width: 1280px)");
  const query = useMemo(
    () => ({ status: ["candidate"], needs_review: onlyFlagged ? true : undefined, sort, order: sort === "due" ? ("asc" as const) : ("desc" as const), limit: 500 }),
    [onlyFlagged, sort],
  );
  const { data, error, isLoading, refetch } = useTasks(query);
  const items = useMemo(() => data?.items ?? [], [data]);
  const visibleIds = new Set(items.map((i) => i.id));
  const chosen = [...selected].filter((id) => visibleIds.has(id));
  // After a candidate is confirmed or dismissed it leaves the list and the next one is shown.
  const requested = params.get("task");
  const activeId = requested && visibleIds.has(requested) ? requested : items[0]?.id;

  const clear = () => setSelected(new Set());
  const confirmBatch = useAction(() => api.batch(chosen, "confirm"), { success: (r) => t("inbox.confirmed", { count: r.count }), onSuccess: clear });
  const dismissBatch = useAction(() => api.batch(chosen, "dismiss"), { success: (r) => t("inbox.dismissed", { count: r.count }), onSuccess: clear });
  const batchBusy = confirmBatch.isPending || dismissBatch.isPending;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = items.length > 0 && chosen.length === items.length ? true : chosen.length > 0 ? "indeterminate" : false;

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("task", id);
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
          <Checkbox
            checked={allChecked}
            onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
            aria-label={t("common.all")}
            disabled={items.length === 0}
          />
          {chosen.length ? (
            <>
              <span className="text-sm">{t("common.selected", { count: chosen.length })}</span>
              <div className="ml-auto flex gap-1.5">
                <Button size="xs" onClick={() => confirmBatch.mutate(undefined)} disabled={batchBusy}>
                  <Check /> {t("inbox.confirmSelected")}
                </Button>
                <Button variant="outline" size="xs" onClick={() => dismissBatch.mutate(undefined)} disabled={batchBusy}>
                  <Ban /> {t("inbox.dismissSelected")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Label className="text-[13px] font-normal">
                <Switch checked={onlyFlagged} onCheckedChange={setOnlyFlagged} />
                {t("inbox.needsReviewOnly")}
              </Label>
              <SimpleSelect
                className="ml-auto h-8 w-auto"
                value={sort}
                onValueChange={setSort}
                ariaLabel={t("common.sort")}
                options={[
                  { value: "detected_at", label: t("inbox.sortDetected") },
                  { value: "due", label: t("inbox.sortDue") },
                ]}
              />
            </>
          )}
        </div>
        {isLoading ? <LoadingRows rows={5} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {!isLoading && !error && items.length === 0 ? (
          <EmptyState icon={Inbox} title={t("inbox.empty")} description={t("inbox.emptyHint")} />
        ) : null}
        <div className="grid gap-2">
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selected={selected.has(task.id)}
              onSelectedChange={(on) => toggle(task.id, on)}
              active={wide && task.id === activeId}
              onOpen={wide ? () => open(task.id) : undefined}
            />
          ))}
        </div>
      </div>
      <div className="hidden xl:block">
        {activeId ? (
          <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-xl border bg-background p-5 scrollbar-thin">
            <TaskDetailView key={activeId} taskId={activeId} embedded onDeleted={() => setParams({}, { replace: true })} />
          </div>
        ) : items.length ? (
          <EmptyState icon={MousePointerClick} title={t("inbox.selectTask")} />
        ) : null}
      </div>
    </div>
  );
}

function Suggestions() {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useSuggestions();
  if (isLoading) return <LoadingRows rows={3} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const items = data?.items ?? [];
  if (items.length === 0) return <EmptyState icon={Lightbulb} title={t("inbox.suggestionsEmpty")} description={t("inbox.suggestionsEmptyHint")} />;
  return (
    <div className="grid max-w-3xl gap-3">
      {items.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} />
      ))}
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
    <div className="grid gap-5">
      <PageHeader title={t("inbox.title")} description={t("inbox.description")} />
      <Tabs value={tab} onValueChange={(v) => setParams(v === "suggestions" ? { tab: v } : {}, { replace: true })}>
        <TabsList>
          <TabsTrigger value="candidates">
            {t("inbox.candidatesTab")}
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular-nums">{candidates?.total ?? 0}</span>
          </TabsTrigger>
          <TabsTrigger value="suggestions">
            {t("inbox.suggestionsTab")}
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular-nums">{suggestions?.items.length ?? 0}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="candidates" className="mt-4">
          <Candidates />
        </TabsContent>
        <TabsContent value="suggestions" className="mt-4">
          <Suggestions />
        </TabsContent>
      </Tabs>
    </div>
  );
}
