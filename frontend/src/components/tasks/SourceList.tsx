import { ChevronRight, ExternalLink, FileText, FlaskConical, Image, Mail, PenLine, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
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
  manual_merge: "primary",
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

/** The mail in Gmail (opens in the browser); TaskRadar itself no longer reads mail or opens imported files. */
function SourceLinks({ entry }: { entry: TaskSourceEntry }) {
  const { t } = useTranslation();
  const msg = entry.message;
  if (!msg?.web_link || msg.source_kind !== "gmail") return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="xs" asChild>
        <a href={msg.web_link} target="_blank" rel="noreferrer noopener">
          <ExternalLink /> {t("detail.openInGmail")}
        </a>
      </Button>
    </div>
  );
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
 * Where an earlier version found the task: every mail or file with its verbatim quotes, collapsed to one line each.
 * Only tasks of earlier versions have sources; the user's own to-dos have none.
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
