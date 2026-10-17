import { ChevronRight, Ellipsis, ExternalLink, Eye, FileText, FolderOpen, Image, Mail, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { SimpleSelect } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useAction, useDocuments, useMessages } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { buildRecords, matchesFilter, type Outcome, type OutcomeFilter, type RecordItem, type Translate } from "@/lib/records";
import { DocumentDetailsDialog, MessageDetailsDialog } from "./RecordDetails";

const OUTCOME_TONE: Record<Outcome, BadgeTone> = {
  failed: "destructive",
  skipped: "normal",
  tasks: "success",
  no_tasks: "outline",
  pending: "primary",
};

function RecordActions({ item, onDetails, onDelete }: { item: RecordItem; onDetails: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const reprocess = useAction(async (): Promise<unknown> => (item.kind === "message" ? api.reprocessMessage(item.id) : api.reprocessDocument(item.id)), {
    success: t("sources.documents.reprocessed"),
  });
  const reveal = useAction(() => api.revealDocument(item.id), { success: t("detail.revealed"), invalidate: false });
  const doc = item.document;
  const msg = item.message;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`${t("common.actions")}: ${item.title}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onDetails}>
          <Eye /> {t("records.inspect")}
        </DropdownMenuItem>
        {msg?.web_link && msg.source_kind === "gmail" ? (
          <DropdownMenuItem asChild>
            <a href={msg.web_link} target="_blank" rel="noreferrer noopener">
              <ExternalLink /> {t("detail.openInGmail")}
            </a>
          </DropdownMenuItem>
        ) : null}
        {doc && (doc.has_stored_copy || doc.original_path) ? (
          <>
            <DropdownMenuItem asChild>
              <a href={api.documentFileUrl(doc.id)} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> {t("detail.viewFile")}
              </a>
            </DropdownMenuItem>
            {doc.original_path ? (
              <DropdownMenuItem onSelect={() => reveal.mutate(undefined)}>
                <FolderOpen /> {t("detail.reveal")}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => reprocess.mutate(undefined)} disabled={reprocess.isPending}>
          <RefreshCw /> {item.outcome === "failed" ? t("records.retry") : t("sources.documents.reprocess")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 /> {t("sources.documents.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_6.5rem_2rem]";

function RecordRow({
  item,
  timezone,
  nested = false,
  onDetails,
  onDelete,
}: {
  item: RecordItem;
  timezone: string;
  nested?: boolean;
  onDetails: (item: RecordItem) => void;
  onDelete: (item: RecordItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(item.attachments.length > 0 && item.attachments.length <= 2);
  const Icon = item.kind === "message" ? Mail : item.document?.kind === "image" ? Image : FileText;
  const failedChildren = item.attachments.filter((a) => a.outcome === "failed").length;
  return (
    <li className={cn(nested && "border-t border-dashed")}>
      <div className={cn(GRID, "px-3 py-2", nested ? "pl-10" : "", item.outcome === "failed" && "bg-destructive/5")}>
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid min-w-0 gap-0.5">
            <button type="button" onClick={() => onDetails(item)} className="truncate text-left text-sm font-medium outline-none hover:underline focus-visible:underline" title={item.title}>
              {item.title}
            </button>
            <p className="truncate text-xs text-muted-foreground" title={item.subtitle}>
              {item.subtitle}
              {item.sourceKind && !nested ? ` · ${translateKey(`sourceKind.${item.sourceKind}`, item.sourceKind)}` : ""}
            </p>
          </div>
        </div>
        <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-6.5 md:col-span-1 md:pl-0">
          <Badge tone={OUTCOME_TONE[item.outcome]}>{item.outcome === "tasks" && item.reason ? item.reason : t(`records.outcome.${item.outcome}`)}</Badge>
          {item.reason && item.outcome !== "tasks" ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={item.reason}>
              {item.reason}
            </span>
          ) : null}
          {failedChildren ? <span className="text-xs text-destructive">{t("records.attachmentsFailed", { count: failedChildren })}</span> : null}
        </div>
        <Tip content={formatDateTime(item.time, i18n.language, timezone)}>
          <span className="hidden text-xs whitespace-nowrap text-muted-foreground md:block">{formatRelativeTime(item.time, i18n.language)}</span>
        </Tip>
        <div className="row-start-1 flex justify-end md:row-auto">
          <RecordActions item={item} onDetails={() => onDetails(item)} onDelete={() => onDelete(item)} />
        </div>
      </div>
      {item.attachments.length ? (
        <>
          {item.attachments.length > 2 ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 py-1.5 pl-10 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
              {t("records.attachments", { count: item.attachments.length })}
            </button>
          ) : null}
          {open ? (
            <ul>
              {item.attachments.map((a) => (
                <RecordRow key={a.key} item={a} timezone={timezone} nested onDetails={onDetails} onDelete={onDelete} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

const PAGE = 40;
const FILTERS: OutcomeFilter[] = ["all", "failed", "tasks", "no_tasks", "skipped"];
const SOURCE_FILTERS = ["all", "gmail", "folder", "upload", "demo_mail", "sample_upload"] as const;

/** Everything TaskRadar has read, with what came of it: found tasks, nothing to do, skipped (why), failed (why). */
export function ProcessingRecords({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const documents = useDocuments();
  const messages = useMessages();
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  // `?records=upload` (from a source's "view files") opens the records filtered to that source.
  const [params] = useSearchParams();
  const requested = SOURCE_FILTERS.find((s) => s === params.get("records")) ?? null;
  const [source, setSource] = useState<(typeof SOURCE_FILTERS)[number]>(requested ?? "all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [seenRequest, setSeenRequest] = useState(requested);
  if (requested !== seenRequest) {
    setSeenRequest(requested);
    if (requested) {
      setSource(requested);
      setShown(PAGE);
    }
  }
  const [details, setDetails] = useState<RecordItem | null>(null);
  const [toDelete, setToDelete] = useState<RecordItem | null>(null);
  const remove = useAction(() => (toDelete?.kind === "message" ? api.deleteMessage(toDelete.id) : api.deleteDocument(toDelete?.id ?? 0)), {
    success: t("sources.documents.deleted"),
    onSuccess: () => setToDelete(null),
  });

  const all = useMemo(
    () => buildRecords(messages.data?.items ?? [], documents.data?.items ?? [], t as unknown as Translate),
    [messages.data, documents.data, t],
  );
  const bySource = source === "all" ? all : all.filter((i) => i.sourceKind === source);
  const needle = q.trim().toLowerCase();
  const searched = needle
    ? bySource.filter((i) => [i.title, i.subtitle, ...i.attachments.map((a) => a.title)].some((s) => s.toLowerCase().includes(needle)))
    : bySource;
  const counts = Object.fromEntries(FILTERS.map((f) => [f, searched.filter((i) => matchesFilter(i, f)).length])) as Record<OutcomeFilter, number>;
  const visible = searched.filter((i) => matchesFilter(i, filter));
  const loading = documents.isLoading || messages.isLoading;
  const error = documents.error ?? messages.error;
  const reset = (fn: () => void) => {
    fn();
    setShown(PAGE);
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("records.filterLabel")}>
          {FILTERS.map((f) => (
            <Button
              key={f}
              variant={filter === f ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={filter === f}
              onClick={() => reset(() => setFilter(f))}
              className={cn(filter !== f && "text-muted-foreground", f === "failed" && counts.failed > 0 && "text-destructive")}
            >
              {t(`records.filter.${f}`)}
              <span className="tabular-nums opacity-70">{counts[f]}</span>
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SimpleSelect
            className="h-8 w-auto text-[13px]"
            value={source}
            onValueChange={(v) => reset(() => setSource(v))}
            ariaLabel={t("tasks.filterSource")}
            options={SOURCE_FILTERS.map((s) => ({ value: s, label: s === "all" ? t("records.allSources") : translateKey(`sourceKind.${s}`, s) }))}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => reset(() => setQ(e.target.value))} placeholder={t("records.search")} aria-label={t("records.search")} className="h-8 w-56 pl-8" />
          </div>
        </div>
      </div>

      <div className="border-b">
        <div className={cn(GRID, "hidden border-b px-3 py-2 text-xs font-medium text-muted-foreground md:grid")}>
          <span>{t("records.colItem")}</span>
          <span>{t("records.colResult")}</span>
          <span>{t("records.colTime")}</span>
          <span />
        </div>
        {loading ? <LoadingRows rows={4} className="p-2" /> : null}
        {error ? <ErrorState error={error} onRetry={() => void Promise.all([documents.refetch(), messages.refetch()])} className="m-3" /> : null}
        {!loading && !error && visible.length === 0 ? (
          <EmptyState
            compact
            icon={all.length ? Search : FileText}
            title={all.length ? t("records.emptyFiltered") : t("records.empty")}
            className="m-3 border-none"
            action={
              all.length && (filter !== "all" || source !== "all" || q) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    reset(() => {
                      setFilter("all");
                      setSource("all");
                      setQ("");
                    })
                  }
                >
                  <X /> {t("tasks.clearFilters")}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        <ul className="divide-y">
          {visible.slice(0, shown).map((item) => (
            <RecordRow key={item.key} item={item} timezone={timezone} onDetails={setDetails} onDelete={setToDelete} />
          ))}
        </ul>
        {visible.length > shown ? (
          <div className="border-t p-2 text-center">
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              {t("records.showMore", { count: visible.length - shown })}
            </Button>
          </div>
        ) : null}
      </div>

      <DocumentDetailsDialog id={details?.kind === "document" ? details.id : null} onClose={() => setDetails(null)} timezone={timezone} />
      <MessageDetailsDialog id={details?.kind === "message" ? details.id : null} onClose={() => setDetails(null)} timezone={timezone} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete?.kind === "message" ? t("sources.messages.deleteTitle") : t("sources.documents.deleteTitle")}
        description={
          <>
            <span className="font-medium break-all text-foreground">{toDelete?.title}</span>
            <br />
            {toDelete?.kind === "message" ? t("sources.messages.deleteDescription") : t("sources.documents.deleteDescription")}
          </>
        }
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}
