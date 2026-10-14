import { BadgeCheck, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import type { Evidence } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<Evidence["kind"], string> = {
  action: "border-l-primary",
  deadline: "border-l-urgent",
  completion: "border-l-success",
  context: "border-l-border",
};

/** Verbatim quotes from the source that support a conclusion (task, deadline, completion…). */
export function EvidenceList({ evidence, className }: { evidence: Evidence[]; className?: string }) {
  const { t } = useTranslation();
  if (evidence.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{t("detail.noEvidence")}</p>;
  }
  return (
    <ul className={cn("grid gap-2", className)}>
      {evidence.map((e, i) => (
        <li key={`${e.kind}-${e.start ?? i}-${i}`} className={cn("rounded-md border border-l-[3px] bg-muted/40 px-3 py-2", KIND_STYLE[e.kind])}>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <span>{t(`evidenceKind.${e.kind}`)}</span>
            {e.page ? <span className="normal-case">· {t("common.page", { page: e.page })}</span> : null}
            <Tip content={e.verified ? t("detail.verified") : t("detail.unverified")}>
              <span className="ml-auto inline-flex">
                {e.verified ? (
                  <BadgeCheck className="size-3.5 text-success" aria-label={t("detail.verified")} />
                ) : (
                  <CircleHelp className="size-3.5 text-high" aria-label={t("detail.unverified")} />
                )}
              </span>
            </Tip>
          </div>
          <blockquote className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">“{e.quote}”</blockquote>
        </li>
      ))}
    </ul>
  );
}
