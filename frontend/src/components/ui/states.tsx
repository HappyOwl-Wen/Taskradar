import { CircleAlert, RefreshCw, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function LoadingRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("grid gap-2", className)} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      <div className={cn("grid place-items-center rounded-full bg-muted text-muted-foreground", compact ? "size-9" : "size-11")}>
        <Icon className={compact ? "size-4" : "size-5"} />
      </div>
      <p className="mt-1 text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center", className)}
    >
      <CircleAlert className="size-5 text-destructive" />
      <p className="text-sm font-medium">{t("common.error")}</p>
      <p className="max-w-md text-[13px] text-muted-foreground">{errorMessage(error)}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
          <RefreshCw /> {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="grid gap-1">
        <h1 className="text-page font-semibold">{title}</h1>
        {description ? <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn("h-px w-full bg-border", className)} />;
}
