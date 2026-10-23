import { AlertCircle, ChevronDown, LoaderCircle, MessageCircle, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, Popover, PopoverContent, PopoverTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
import type { AgentConfig, AgentModel, AgentModels, AgentStatus, ReasoningEffort } from "@/lib/agent";
import { modelCapability } from "@/lib/agent";
import { errorMessage } from "@/lib/errors";

const selectClass = "h-8 min-w-0 w-full rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function ThinkingSelect({ value, onChange, capability, disabled, id }: {
  value: ReasoningEffort; onChange: (value: ReasoningEffort) => void; capability?: AgentModel; disabled?: boolean; id?: string;
}) {
  const { t } = useTranslation();
  const levels = capability?.reasoning_levels ?? ["auto"];
  return <select id={id} aria-label={t("agent.controls.reasoning")} className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ReasoningEffort)}>
    {!levels.includes(value) ? <option value={value} disabled>{t(`agent.controls.${value}`)} · {t("agent.controls.unsupported")}</option> : null}
    {levels.map((level) => <option key={level} value={level}>{t(`agent.controls.${level}`)}</option>)}
  </select>;
}

export function AgentControls({ config, catalog, error, scanning, busy, refreshing, onRefresh, onChange, children }: {
  config: AgentStatus; catalog?: AgentModels; error: unknown; scanning: boolean; busy: boolean; refreshing: boolean;
  onRefresh: () => void;
  onChange: (changes: Partial<Pick<AgentConfig, "model" | "reasoning_effort" | "execution_mode">>) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const capability = modelCapability(config, catalog);
  const models = catalog?.models.filter((model) => model.usable) ?? [];
  const modelName = capability?.name ?? config.model;
  const effort = config.reasoning_effort === "auto" ? t("agent.controls.autoShort") : t(`agent.controls.${config.reasoning_effort}`);
  const description = `${modelName} · ${t(`agent.controls.${config.reasoning_effort}`)}`;
  const yolo = config.workspace_access && config.execution_mode === "yolo";
  const ModeIcon = !config.workspace_access ? MessageCircle : yolo ? ShieldAlert : ShieldCheck;
  return <div className="flex min-w-0 flex-1 items-center gap-1">
    <DropdownMenu><DropdownMenuTrigger asChild>
      <Button variant="ghost" size="sm" className={"h-8 gap-1 px-1.5 text-xs " + (yolo ? "text-urgent" : "text-muted-foreground")} disabled={busy}
        aria-label={t("agent.controls.mode")} title={!config.workspace_access ? t("agent.chatOnly") : t(`agent.controls.${config.execution_mode}`)}>
        <ModeIcon className="size-3.5" /><span>{!config.workspace_access ? t("agent.controls.chatShort") : t(`agent.controls.${config.execution_mode}Short`)}</span>
      </Button>
    </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t("agent.controls.mode")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={config.execution_mode} onValueChange={(mode) => onChange({ execution_mode: mode as "restricted" | "yolo" })}>
          <DropdownMenuRadioItem value="restricted">{t("agent.controls.restricted")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="yolo">{t("agent.controls.yolo")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">{!config.workspace_access ? t("agent.chatOnly") : t("agent.preferences.modeHint")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
    {children}
    <Popover><PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="ml-auto h-8 min-w-0 shrink gap-1 px-1.5 text-xs text-muted-foreground" disabled={busy}
        aria-label={t("agent.controls.modelSettings")} aria-description={description} title={`${description}\n${t("agent.controls.nextMessage")}`}>
        <span className="truncate font-medium text-foreground">{modelName}</span><span className="shrink-0">{effort}</span>
        {scanning || refreshing ? <LoaderCircle className="size-3 animate-spin" /> : error ? <AlertCircle className="size-3 text-urgent" /> : <ChevronDown className="size-3" />}
      </Button>
    </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label={t("agent.controls.modelSettings")}
        className="grid max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto p-3">
        <div className="flex items-end gap-1">
          <label className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium">{t("agent.controls.model")}
            <select className={selectClass} value={config.model} aria-label={t("agent.controls.model")} disabled={busy} onChange={(e) => onChange({ model: e.target.value, reasoning_effort: "auto" })}>
              {!models.some((model) => model.id === config.model) ? <option value={config.model}>{config.model}</option> : null}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("agent.controls.refresh")} title={t("agent.controls.refresh")} disabled={busy || !config.configured} loading={refreshing || scanning} onClick={onRefresh}><RefreshCw className="size-3.5" /></Button>
        </div>
        <label className="grid gap-1.5 text-xs font-medium">{t("agent.controls.reasoning")}<ThinkingSelect value={config.reasoning_effort} capability={capability} disabled={busy} onChange={(reasoning_effort) => onChange({ reasoning_effort })} /></label>
        <div className="grid gap-1 text-[11px] leading-relaxed text-muted-foreground">
          <p>{error ? errorMessage(error) : scanning ? t("agent.controls.scanning") : t(`agent.controls.${capability?.capability_source ?? "unknown"}`)}</p>
          {capability?.reasoning_kind === "budget" ? <p>{t("agent.controls.thinkingBudget")}</p> : null}
          <p>{t("agent.controls.nextMessage")}</p>
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
