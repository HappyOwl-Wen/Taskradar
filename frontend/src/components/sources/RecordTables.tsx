import { Ellipsis, ExternalLink, Eye, FileText, FolderOpen, Image, Mail, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useAction } from "@/lib/queries";
import type { DocumentBrief, MessageListItem } from "@/lib/types";
import { DocumentDetailsDialog, MessageDetailsDialog } from "./RecordDetails";

const STATUS_TONE: Record<string, BadgeTone> = { pending: "primary", processed: "success", skipped: "normal", failed: "destructive" };

function ItemStatusBadge({ status, error }: { status: string; error?: string | null }) {
  const badge = <Badge tone={STATUS_TONE[status] ?? "normal"}>{translateKey(`itemStatus.${status}`, status)}</Badge>;
  return error ? (
    <Tip content={error}>
      <span>{badge}</span>
    </Tip>
  ) : (
    badge
  );
}

const th = "px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const td = "px-3 py-2.5 align-middle";

export function DocumentsTable({ documents, timezone }: { documents: DocumentBrief[]; timezone: string }) {
  const { t, i18n } = useTranslation();
  const [details, setDetails] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<DocumentBrief | null>(null);
  const reprocess = useAction((id: number) => api.reprocessDocument(id), { success: t("sources.documents.reprocessed") });
  const reveal = useAction((id: number) => api.revealDocument(id), { success: t("detail.revealed"), invalidate: false });
  const remove = useAction((id: number) => api.deleteDocument(id), { success: t("sources.documents.deleted"), onSuccess: () => setToDelete(null) });
  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>{t("sources.documents.name")}</th>
              <th className={th}>{t("sources.documents.status")}</th>
              <th className={th}>{t("sources.documents.method")}</th>
              <th className={th}>{t("sources.documents.tasks")}</th>
              <th className={th}>{t("sources.documents.imported")}</th>
              <th className={th}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {documents.map((d) => {
              const Icon = d.kind === "image" ? Image : FileText;
              const errorText = d.error_code ? translateKey(`errors.${d.error_code}`, d.error_message ?? d.error_code) : null;
              return (
                <tr key={d.id} className="hover:bg-muted/30">
                  <td className={td}>
                    <button type="button" onClick={() => setDetails(d.id)} className="flex min-w-0 items-center gap-2 text-left hover:underline">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="max-w-[18rem] truncate font-medium">{d.name}</span>
                    </button>
                    <p className="pl-6 text-xs text-muted-foreground">
                      {formatBytes(d.size_bytes)}
                      {d.page_count ? ` · ${t("sources.documents.pages", { count: d.page_count })}` : ""}
                      {d.source_kind ? ` · ${translateKey(`sourceKind.${d.source_kind}`, d.source_kind)}` : ""}
                    </p>
                  </td>
                  <td className={td}>
                    <ItemStatusBadge status={d.status} error={errorText} />
                  </td>
                  <td className={`${td} text-xs text-muted-foreground`}>
                    {d.extraction_method ? translateKey(`method.${d.extraction_method}`, d.extraction_method) : "—"}
                    {d.language ? ` · ${d.language}` : ""}
                  </td>
                  <td className={`${td} tabular-nums`}>{d.task_count ?? 0}</td>
                  <td className={`${td} text-xs whitespace-nowrap text-muted-foreground`}>{formatDateTime(d.imported_at, i18n.language, timezone)}</td>
                  <td className={`${td} text-right`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`${t("common.actions")}: ${d.name}`}>
                          <Ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDetails(d.id)}>
                          <Eye /> {t("common.details")}
                        </DropdownMenuItem>
                        {d.has_stored_copy || d.original_path ? (
                          <>
                            <DropdownMenuItem asChild>
                              <a href={api.documentFileUrl(d.id)} target="_blank" rel="noreferrer noopener">
                                <ExternalLink /> {t("detail.viewFile")}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => reveal.mutate(d.id)}>
                              <FolderOpen /> {t("detail.reveal")}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                        <DropdownMenuItem onSelect={() => reprocess.mutate(d.id)} disabled={reprocess.isPending}>
                          <RefreshCw /> {t("sources.documents.reprocess")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onSelect={() => setToDelete(d)}>
                          <Trash2 /> {t("sources.documents.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DocumentDetailsDialog id={details} onClose={() => setDetails(null)} timezone={timezone} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("sources.documents.deleteTitle")}
        description={
          <>
            <span className="font-medium text-foreground">{toDelete?.name}</span>
            <br />
            {t("sources.documents.deleteDescription")}
          </>
        }
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </>
  );
}

export function MessagesTable({ messages, timezone }: { messages: MessageListItem[]; timezone: string }) {
  const { t, i18n } = useTranslation();
  const [details, setDetails] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<MessageListItem | null>(null);
  const reprocess = useAction((id: number) => api.reprocessMessage(id), { success: t("sources.documents.reprocessed") });
  const remove = useAction((id: number) => api.deleteMessage(id), { success: t("sources.documents.deleted"), onSuccess: () => setToDelete(null) });
  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>{t("sources.messages.subject")}</th>
              <th className={th}>{t("sources.documents.status")}</th>
              <th className={th}>{t("sources.messages.type")}</th>
              <th className={th}>{t("sources.documents.tasks")}</th>
              <th className={th}>{t("sources.messages.date")}</th>
              <th className={th}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {messages.map((m) => (
              <tr key={m.id} className="hover:bg-muted/30">
                <td className={td}>
                  <button type="button" onClick={() => setDetails(m.id)} className="flex min-w-0 items-center gap-2 text-left hover:underline">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="max-w-[20rem] truncate font-medium">{m.subject || t("sources.messages.noSubject")}</span>
                  </button>
                  <p className="max-w-[22rem] truncate pl-6 text-xs text-muted-foreground">{m.sender}</p>
                </td>
                <td className={td}>
                  <ItemStatusBadge status={m.status} error={m.error_code ? translateKey(`errors.${m.error_code}`, m.error_code) : m.skip_reason} />
                </td>
                <td className={`${td} text-xs text-muted-foreground`}>
                  {m.content_type ? translateKey(`contentType.${m.content_type}`, m.content_type) : "—"}
                </td>
                <td className={`${td} tabular-nums`}>{m.task_count}</td>
                <td className={`${td} text-xs whitespace-nowrap text-muted-foreground`}>{formatDateTime(m.sent_at, i18n.language, timezone)}</td>
                <td className={`${td} text-right`}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={`${t("common.actions")}: ${m.subject}`}>
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setDetails(m.id)}>
                        <Eye /> {t("common.details")}
                      </DropdownMenuItem>
                      {m.web_link && m.source_kind === "gmail" ? (
                        <DropdownMenuItem asChild>
                          <a href={m.web_link} target="_blank" rel="noreferrer noopener">
                            <ExternalLink /> {t("detail.openInGmail")}
                          </a>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onSelect={() => reprocess.mutate(m.id)} disabled={reprocess.isPending}>
                        <RefreshCw /> {t("sources.messages.reprocess")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => setToDelete(m)}>
                        <Trash2 /> {t("sources.messages.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MessageDetailsDialog id={details} onClose={() => setDetails(null)} timezone={timezone} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("sources.messages.deleteTitle")}
        description={t("sources.messages.deleteDescription")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </>
  );
}
