import { useTranslation } from "react-i18next";
import type { AgentTurn } from "@/lib/agent";

const fields = ["total_input_tokens", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;

export function AgentUsage({ turn }: { turn: AgentTurn }) {
  const { t, i18n } = useTranslation();
  if (!turn.options?.usage || turn.provider !== "anthropic") return null;
  const usage = turn.options.usage;
  const groups = (["chat", "title", "suggestions"] as const).flatMap((kind) => {
    const value = usage[kind];
    return value && value.requests > 0 ? [[kind, value] as const] : [];
  });
  if (!groups.length) return null;
  const format = (n: number) => n.toLocaleString(i18n.language);
  const cacheKnown = groups.every(([, value]) => typeof value?.cache_read_input_tokens === "number");
  const reads = groups.reduce((total, [, value]) => total + (value?.cache_read_input_tokens ?? 0), 0);
  return <details className="rounded-lg border px-3 py-2 text-[11px] text-muted-foreground">
    <summary className="cursor-pointer leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {t("agent.cache.usage")} · {cacheKnown ? t("agent.cache.readSummary", { count: reads }) : t("agent.cache.unavailable")}
    </summary>
    <div className="mt-3 grid gap-3">
      {groups.map(([kind, value]) => value ? <section key={kind} className="grid gap-1.5" aria-label={t(`agent.cache.${kind}`)}>
        <p className="flex flex-wrap justify-between gap-1 font-medium text-foreground"><span>{t(`agent.cache.${kind}`)}</span><span>{t("agent.cache.calls", { count: value.requests })}</span></p>
        <p className="truncate text-[10px]" title={value.models.join(", ")}>{value.models.join(", ")}</p>
        <dl className="grid gap-y-1">
          {fields.map((field) => <div key={field} className="flex min-w-0 justify-between gap-2"><dt>{t(`agent.cache.${field}`)}</dt><dd className="tabular-nums">{typeof value[field] === "number" ? format(value[field]) : t("agent.cache.unknown")}</dd></div>)}
        </dl>
        <p className="text-[10px]">{t("agent.cache.reported", { reported: value.reported_requests, count: value.requests })}</p>
      </section> : null)}
      <p className="text-[10px] leading-relaxed">{t("agent.cache.reportedHint")}</p>
    </div>
  </details>;
}
