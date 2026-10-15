import { describeCode, translateKey } from "@/i18n";
import { formatBytes } from "./format";
import type { DocumentBrief, MessageListItem } from "./types";

/** Processing records: every mail and file TaskRadar read, and what came of it. */
export type Outcome = "failed" | "skipped" | "tasks" | "no_tasks" | "pending";

export interface RecordItem {
  key: string;
  kind: "message" | "document";
  id: number;
  title: string;
  subtitle: string;
  sourceKind: string | null;
  outcome: Outcome;
  /** Why: the error, the skip reason or what the content was. Never a bare code. */
  reason: string | null;
  taskCount: number;
  time: string | null;
  attachments: RecordItem[];
  /** The record or one of its attachments failed. */
  hasFailure: boolean;
  message?: MessageListItem;
  document?: DocumentBrief;
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export function documentItem(d: DocumentBrief, t: Translate): RecordItem {
  let outcome: Outcome;
  let reason: string | null = null;
  if (d.status === "failed") {
    outcome = "failed";
    reason = d.error_code ? translateKey(`errors.${d.error_code}`, d.error_message ?? d.error_code) : (d.error_message ?? null);
  } else if (d.status === "skipped") {
    outcome = "skipped";
    const code = d.warnings.find((w) => w.startsWith("duplicate_")) ?? d.warnings[0];
    reason = code ? describeCode(code) : null;
  } else if (d.status === "pending") {
    outcome = "pending";
  } else if ((d.task_count ?? 0) > 0) {
    outcome = "tasks";
    reason = t("records.foundTasks", { count: d.task_count ?? 0 });
  } else {
    outcome = "no_tasks";
    reason = d.warnings.includes("ocr_unavailable")
      ? t("records.textNotRead")
      : d.warnings.includes("no_text_found") || d.extraction_method === "none"
        ? t("records.noText")
        : t("records.noObligation");
  }
  const parts = [d.kind === "image" ? t("records.image") : "PDF", formatBytes(d.size_bytes), d.page_count && d.page_count > 1 ? t("sources.documents.pages", { count: d.page_count }) : null];
  return {
    key: `d:${d.id}`,
    kind: "document",
    id: d.id,
    title: d.name,
    subtitle: parts.filter(Boolean).join(" · "),
    sourceKind: d.source_kind,
    outcome,
    reason,
    taskCount: d.task_count ?? 0,
    time: d.imported_at,
    attachments: [],
    hasFailure: outcome === "failed",
    document: d,
  };
}

export function messageItem(m: MessageListItem, attachments: DocumentBrief[], t: Translate): RecordItem {
  let outcome: Outcome;
  let reason: string | null = null;
  if (m.status === "failed") {
    outcome = "failed";
    reason = m.error_code ? translateKey(`errors.${m.error_code}`, m.error_code) : null;
  } else if (m.status === "skipped") {
    outcome = "skipped";
    reason = m.skip_reason ? describeCode(m.skip_reason) : null;
  } else if (m.status === "pending") {
    outcome = "pending";
  } else if (m.task_count > 0) {
    outcome = "tasks";
    reason = t("records.foundTasks", { count: m.task_count });
  } else {
    outcome = "no_tasks";
    reason = m.content_type ? t("records.noObligationKind", { kind: translateKey(`contentType.${m.content_type}`, m.content_type) }) : t("records.noObligation");
  }
  const children = attachments.map((a) => documentItem(a, t));
  return {
    key: `m:${m.id}`,
    kind: "message",
    id: m.id,
    title: m.subject || t("sources.messages.noSubject"),
    subtitle: m.sender,
    sourceKind: m.source_kind,
    outcome,
    reason,
    taskCount: m.task_count,
    time: m.sent_at,
    attachments: children,
    hasFailure: outcome === "failed" || children.some((c) => c.outcome === "failed"),
    message: m,
  };
}

/**
 * Mails and files as one list: attachments sit under their mail (so a signature image that every
 * mail carries does not flood the list), failures come first, newest first otherwise.
 */
export function buildRecords(messages: MessageListItem[], documents: DocumentBrief[], t: Translate): RecordItem[] {
  const byMessage = new Map<number, DocumentBrief[]>();
  const known = new Set(messages.map((m) => m.id));
  const standalone: DocumentBrief[] = [];
  for (const d of documents) {
    if (d.message_id !== null && known.has(d.message_id)) byMessage.set(d.message_id, [...(byMessage.get(d.message_id) ?? []), d]);
    else standalone.push(d);
  }
  const items = [...messages.map((m) => messageItem(m, byMessage.get(m.id) ?? [], t)), ...standalone.map((d) => documentItem(d, t))];
  const time = (i: RecordItem) => Date.parse(i.time ?? "") || 0;
  return items.sort((a, b) => Number(b.hasFailure) - Number(a.hasFailure) || time(b) - time(a));
}

export type OutcomeFilter = "all" | "failed" | "tasks" | "no_tasks" | "skipped";

export function matchesFilter(item: RecordItem, filter: OutcomeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return item.hasFailure;
  return item.outcome === filter;
}

