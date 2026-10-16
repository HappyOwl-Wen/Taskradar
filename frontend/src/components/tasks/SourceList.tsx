import { ChevronRight, ExternalLink, FileText, FlaskConical, FolderOpen, Image, Mail, PenLine, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useAction } from "@/lib/queries";
import type { TaskSourceEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EvidenceList } from "./Evidence";
import { sourceTitle, useSourceWhen } from "./sourceMeta";

const RELATION_TONE: Record<TaskSourceEntry["relation"], BadgeTone> = {
  origin: "primary",
  duplicate: "neutral",
  deadline_update: "urgent",
  completion_evidence: "success",
  related: "outline",
  manual_merge: "violet",
};

const SOURCE_ICONS: Record<"demo" | "mail" | "image" | "pdf" | "manual", LucideIcon> = {
  demo: FlaskConical,
  mail: Mail,
  image: Image,
  pdf: FileText,
  manual: PenLine,
};

function iconKey(entry: TaskSourceEntry): keyof typeof SOURCE_ICONS {
  if (entry.message) return entry.message.source_kind === "demo_mail" ? "demo" : "mail";
  if (entry.document) return entry.document.kind === "image" ? "image" : "pdf";
  return "manual";
}

/** Links to the original: the Gmail message, the stored file, the folder in Explorer. */
export function SourceLinks({ entry }: { entry: TaskSourceEntry }) {
  const { t } = useTranslation();
  const reveal = useAction((id: number) => api.revealDocument(id), { success: t("detail.revealed"), invalidate: false });
  const msg = entry.message;
  const doc = entry.document;
  const links = [];
  if (msg?.web_link && msg.source_kind === "gmail") {
    links.push(
      <Button key="gmail" variant="outline" size="xs" asChild>
        <a href={msg.web_link} target="_blank" rel="noreferrer noopener">
          <ExternalLink /> {t("detail.openInGmail")}
        </a>
      </Button>,
    );
  }
  if (doc && (doc.has_stored_copy || doc.original_path)) {
    links.push(
      <Button key="file" variant="outline" size="xs" asChild>
        <a href={api.documentFileUrl(doc.id)} target="_blank" rel="noreferrer noopener">
          <ExternalLink /> {t("detail.viewFile")}
        </a>
      </Button>,
      <Button key="reveal" variant="ghost" size="xs" onClick={() => reveal.mutate(doc.id)} disabled={reveal.isPending}>
        <FolderOpen /> {t("detail.reveal")}
      </Button>,
    );
  }
  return links.length ? <div className="flex flex-wrap gap-2">{links}</div> : null;
}

function SourceEntry({ entry, timezone, open }: { entry: TaskSourceEntry; timezone: string; open: boolean }) {
  const { t } = useTranslation();
  const when = useSourceWhen(timezone);
  const Icon = SOURCE_ICONS[iconKey(entry)];
  const msg = entry.message;
  const doc = entry.document;
  const meta = [
    msg?.sender,
    doc ? `${doc.kind.toUpperCase()} · ${formatBytes(doc.size_bytes)}` : null,
    doc?.page_count ? t("sources.documents.pages", { count: doc.page_count }) : null,
  ].filter(Boolean);
  return (
    <li>
      <details open={open} className="group/source rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-3 py-2.5 outline-none select-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/source:rotate-90" aria-hidden />
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={sourceTitle(entry)}>
            {sourceTitle(entry)}
          </span>
          <Badge tone={RELATION_TONE[entry.relation]} className="hidden sm:inline-flex">
            {t(`relation.${entry.relation}`)}
          </Badge>
          <span className="shrink-0 text-xs text-muted-foreground">{when(entry)}</span>
        </summary>
        <div className="grid grid-cols-1 gap-3 border-t px-3 py-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge tone={RELATION_TONE[entry.relation]} className="sm:hidden">
              {t(`relation.${entry.relation}`)}
            </Badge>
            {meta.length ? <span>{meta.join(" · ")}</span> : null}
            {entry.origin_key && entry.origin_key !== "manual" ? (
              <span className="font-mono text-[11px] [overflow-wrap:anywhere] opacity-80" title={t("detail.traceId")}>
                {entry.origin_key}
              </span>
            ) : null}
          </p>
          <EvidenceList evidence={entry.evidence} />
          <SourceLinks entry={entry} />
        </div>
      </details>
    </li>
  );
}

/**
 * Every source of a task with its verbatim quotes, collapsed to one line each so that a task with
 * many reminders stays readable. The first source is open by default.
 */
export function SourceList({ sources, timezone, className, openFirst = true }: { sources: TaskSourceEntry[]; timezone: string; className?: string; openFirst?: boolean }) {
  const { t } = useTranslation();
  if (sources.length === 0) return <p className="text-sm text-muted-foreground">{t("detail.manualSource")}</p>;
  return (
    <ul className={cn("grid grid-cols-1 gap-2", className)}>
      {sources.map((entry, i) => (
        <SourceEntry key={entry.id} entry={entry} timezone={timezone} open={openFirst && i === 0} />
      ))}
    </ul>
  );
}
