import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Internal values (scores, rule names, IDs) for checking how a result came about. Collapsed by
 * default and clearly labelled: they are debugging aids, not probabilities of being right.
 */
export function TechnicalDetails({ rows, className, title }: { rows: [string, ReactNode][]; className?: string; title?: string }) {
  const { t } = useTranslation();
  return (
    <details className={cn("group/tech text-xs text-muted-foreground", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/tech:rotate-90" aria-hidden />
        {title ?? t("tech.title")}
      </summary>
      <TechnicalRows rows={rows} className="mt-2" />
    </details>
  );
}

export function TechnicalRows({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground", className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt>{label}</dt>
          <dd className="font-mono text-[11px] [overflow-wrap:anywhere] text-foreground/80">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
