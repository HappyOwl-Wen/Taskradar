import { ExternalLink, FileText, FlaskConical, FolderOpen, Image, Mail, PenLine, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useAction } from "@/lib/queries";
import type { TaskSourceEntry } from "@/lib/types";
import { EvidenceList } from "./Evidence";

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

function SourceEntry({ entry, timezone }: { entry: TaskSourceEntry; timezone: string }) {
  const { t, i18n } = useTranslation();
  const reveal = useAction((id: number) => api.revealDocument(id), { success: t("detail.revealed"), invalidate: false });
  const Icon = SOURCE_ICONS[iconKey(entry)];
  const msg = entry.message;
  const doc = entry.document;
  const date = msg?.sent_at ?? entry.source_date ?? doc?.imported_at ?? entry.created_at;
  return (
    <li className="grid gap-3 rounded-lg border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium">{msg?.subject || doc?.name || entry.label}</p>
            <Badge tone={RELATION_TONE[entry.relation]}>{t(`relation.${entry.relation}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {msg ? `${msg.sender} · ` : null}
            {doc ? `${doc.kind.toUpperCase()} · ${formatBytes(doc.size_bytes)}${doc.page_count ? ` · ${t("sources.documents.pages", { count: doc.page_count })}` : ""} · ` : null}
            {formatDateTime(date, i18n.language, timezone)}
          </p>
        </div>
      </div>
      <EvidenceList evidence={entry.evidence} />
      <div className="flex flex-wrap gap-2">
        {msg?.web_link && msg.source_kind === "gmail" ? (
          <Button variant="outline" size="xs" asChild>
            <a href={msg.web_link} target="_blank" rel="noreferrer noopener">
              <ExternalLink /> {t("detail.openInGmail")}
            </a>
          </Button>
        ) : null}
        {doc && (doc.has_stored_copy || doc.original_path) ? (
          <>
            <Button variant="outline" size="xs" asChild>
              <a href={api.documentFileUrl(doc.id)} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> {t("detail.viewFile")}
              </a>
            </Button>
            <Button variant="ghost" size="xs" onClick={() => reveal.mutate(doc.id)} disabled={reveal.isPending}>
              <FolderOpen /> {t("detail.reveal")}
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

export function SourceList({ sources, timezone }: { sources: TaskSourceEntry[]; timezone: string }) {
  const { t } = useTranslation();
  if (sources.length === 0) return <p className="text-sm text-muted-foreground">{t("detail.manual")}</p>;
  return (
    <ul className="grid gap-3">
      {sources.map((entry) => (
        <SourceEntry key={entry.id} entry={entry} timezone={timezone} />
      ))}
    </ul>
  );
}
