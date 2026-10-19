import { Bot, Cog, Info, Undo2, User, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useAction } from "@/lib/queries";
import type { TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTOR_ICON: Record<TaskEvent["actor"], LucideIcon> = { user: User, agent: Bot, system: Cog };
const EDITABLE = ["title", "description", "action_required", "category", "priority", "due_date", "due_time", "time_semantics"];

function statusOf(value: unknown): string | null {
  if (value && typeof value === "object" && "status" in value) return String((value as { status: unknown }).status);
  return null;
}

/** Localised one-line label computed from the event type and its structured data. */
function useEventLabel() {
  const { t, i18n } = useTranslation();
  return (ev: TaskEvent): string => {
    // Event summaries are written by the backend in Chinese and include source names.
    if (i18n.language === "zh-CN" && ev.summary) return ev.summary;
    const data = ev.data;
    switch (ev.type) {
      case "status_changed": {
        const from = statusOf(data.before);
        const to = statusOf(data.after);
        if (from && to) return t("eventType.status_changed", { from: translateKey(`status.${from}`, from), to: translateKey(`status.${to}`, to) });
        break;
      }
      case "fields_updated": {
        const after = data.after && typeof data.after === "object" ? Object.keys(data.after as object) : [];
        const fields = after.filter((k) => EDITABLE.includes(k)).map((k) => translateKey(`field.${k}`, k));
        return t("eventType.fields_updated", { fields: fields.join(", ") || "—" });
      }
      case "source_attached":
        return t("eventType.source_attached", { relation: translateKey(`relation.${String(data.relation ?? "related")}`, String(data.relation ?? "")) });
      case "suggestion_created":
        return t("eventType.suggestion_created", { kind: translateKey(`suggestionKind.${String(data.kind)}`, String(data.kind)) });
      case "suggestion_resolved":
        return t(data.accepted ? "eventType.suggestion_resolved_accepted" : "eventType.suggestion_resolved_rejected", {
          kind: translateKey(`suggestionKind.${String(data.kind)}`, String(data.kind)),
        });
      default:
        break;
    }
    return translateKey(`eventType.${ev.type}`, ev.summary || ev.type);
  };
}

export function Timeline({ events, timezone }: { events: TaskEvent[]; timezone: string }) {
  const { t, i18n } = useTranslation();
  const label = useEventLabel();
  const undo = useAction((eventId: number) => api.undo(eventId), { success: t("detail.undoSuccess") });

  if (events.length === 0) return <p className="text-sm text-muted-foreground">{t("detail.timelineEmpty")}</p>;
  return (
    <ol className="relative grid gap-4 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-px before:bg-border">
      {events.map((ev) => {
        const Icon = ACTOR_ICON[ev.actor] ?? Cog;
        return (
          <li key={ev.id} className="relative flex gap-3">
            <span
              className={cn(
                "z-10 grid size-7 shrink-0 place-items-center rounded-full border bg-card",
                ev.actor === "agent" && "text-muted-foreground",
                ev.actor === "user" && "text-primary",
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="grid min-w-0 flex-1 gap-1 pt-0.5">
              <p className={cn("text-[13px] leading-snug", ev.reverted && "text-muted-foreground line-through")}>{label(ev)}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t(`actor.${ev.actor}`)}</span>
                <Tip content={formatDateTime(ev.created_at, i18n.language, timezone)}>
                  <span>{formatRelativeTime(ev.created_at, i18n.language)}</span>
                </Tip>
                {ev.reverted ? <Badge tone="normal">{t("detail.undone")}</Badge> : null}
                {ev.actor === "agent" && ev.reason ? (
                  // The agent's internal reason codes are for checking, not for reading: keep them out of the way.
                  <Tip content={<span className="font-mono break-all">{ev.reason}</span>}>
                    <button type="button" className="inline-flex rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={t("tech.title")}>
                      <Info className="size-3.5" />
                    </button>
                  </Tip>
                ) : null}
              </div>
            </div>
            {ev.revertible ? (
              <Tip content={t("common.undo")}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => undo.mutate(ev.id)}
                  disabled={undo.isPending}
                  aria-label={`${t("common.undo")}: ${label(ev)}`}
                >
                  <Undo2 />
                </Button>
              </Tip>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
