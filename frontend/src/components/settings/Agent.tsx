import { CheckCircle2, KeyRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input, SwitchRow } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { AGENT_DEFAULTS, agentApi, agentKeys, modelCapability, useAgentConfig, useAgentModels, type AgentConfig, type AgentProvider } from "@/lib/agent";
import { ThinkingSelect } from "@/components/agent/AgentControls";
import { useAction } from "@/lib/queries";
import { DirtyReporter } from "@/lib/settings";
import { errorMessage } from "@/lib/errors";
import { SaveBar, SettingsCard } from "./common";

export function AgentSection() {
  const { t } = useTranslation();
  const config = useAgentConfig();
  const models = useAgentModels(config.data);
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Partial<AgentConfig>>({});
  const [key, setKey] = useState("");
  const value = config.data ? { ...config.data, ...changes } : null;
  const report = useContext(DirtyReporter);
  const dirty = Object.keys(changes).length > 0 || key.length > 0;
  useEffect(() => {
    report("agent", dirty);
    return () => report("agent", false);
  }, [report, dirty]);
  const reset = () => { setChanges({}); setKey(""); };
  const save = useAction(async () => {
    if (!value) return;
    return agentApi.configure({ provider: value.provider, model: value.model, base_url: value.base_url, workspace_access: value.workspace_access,
      reasoning_effort: value.reasoning_effort, execution_mode: value.execution_mode, title_mode: value.title_mode,
      title_model: value.title_model, prompt_suggestions: value.prompt_suggestions, prompt_cache: value.prompt_cache,
      ...(key.trim() ? { api_key: key.trim() } : {}) });
  }, { success: t("common.saved"), onSuccess: reset });
  const forget = useAction(() => agentApi.forgetKey(), { success: t("agent.config.keyRemoved") });
  const refresh = useAction(() => agentApi.models(true), { invalidate: false, onSuccess: (data) => queryClient.setQueryData(agentKeys.models(config.data), data) });
  const set = <K extends keyof AgentConfig>(field: K, next: AgentConfig[K]) => setChanges((prev) => ({ ...prev, [field]: next }));

  if (config.isLoading) return <LoadingRows rows={5} />;
  if (config.error) return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  if (!value) return null;
  const configured = value.provider === config.data?.provider && config.data.configured;
  const changeProvider = (provider: AgentProvider) => {
    setChanges((prev) => ({ ...prev, provider, ...AGENT_DEFAULTS[provider], reasoning_effort: "auto", title_model: null }));
    setKey("");
  };
  const pending = save.isPending || forget.isPending;
  const sameProfile = value.provider === config.data?.provider && value.base_url === config.data.base_url && !key;
  const catalog = sameProfile ? models.data : undefined;
  const capability = modelCapability(sameProfile ? value : { ...value, model_info: undefined }, catalog);
  return (
    <SettingsCard id="agent-settings" title={t("agent.title")} description={t("agent.config.intro")}
      footer={<SaveBar dirty={dirty} saving={pending} onSave={() => save.mutate()} onReset={reset} />}>
      <div className="flex items-center gap-2 text-sm" role="status">
        {configured ? <CheckCircle2 className="size-4 text-success" /> : <KeyRound className="size-4 text-muted-foreground" />}
        {configured ? t("agent.config.ready") : t("agent.config.missing")}
      </div>
      <Field label={t("agent.config.provider")} htmlFor="agent-provider">
        <SimpleSelect id="agent-provider" value={value.provider} onValueChange={changeProvider} disabled={pending}
          options={(["anthropic", "openai", "openai_compatible"] as const).map((provider) => ({ value: provider, label: t(`agent.config.${provider}`) }))} />
      </Field>
      <Field label={t("agent.config.model")} hint={t("agent.config.modelHint")} htmlFor="agent-model">
        <Input id="agent-model" list="agent-detected-models" value={value.model} onChange={(e) => setChanges((prev) => ({ ...prev, model: e.target.value, reasoning_effort: "auto" }))} maxLength={200} disabled={pending} spellCheck={false} />
        <datalist id="agent-detected-models">{catalog?.models.filter((model) => model.usable).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={!sameProfile || !configured || pending} loading={refresh.isPending || models.isFetching}>{t("agent.controls.refresh")}</Button>
          {catalog ? <span className="text-xs text-muted-foreground">{t("agent.controls.modelCount", { count: catalog.models.length })}</span> : null}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sameProfile ? t("agent.preferences.modelListHint") : t("agent.preferences.saveBeforeScan")}</p>
        {sameProfile && models.error ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{errorMessage(models.error)}</p> : null}
      </Field>
      <Field label={t("agent.config.baseUrl")} hint={t("agent.config.baseUrlHint")} htmlFor="agent-base-url">
        <Input id="agent-base-url" type="url" value={value.base_url} onChange={(e) => set("base_url", e.target.value)} maxLength={1000} disabled={pending} spellCheck={false} />
      </Field>
      <Field label={t("agent.config.apiKey")} hint={t("agent.config.keyHint")} htmlFor="agent-api-key">
        <Input id="agent-api-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} maxLength={4096}
          placeholder={configured ? t("agent.config.keepKey") : t("agent.config.keyPlaceholder")} disabled={pending || !config.data?.secret_store_available} />
      </Field>
      {value.provider === "anthropic" ? <p className="text-xs leading-relaxed text-muted-foreground">{t("agent.config.claudeHint")}</p> : null}
      {!config.data?.secret_store_available ? <p className="text-sm text-destructive" role="alert">{t("agent.config.noStore")}</p> : null}
      {configured ? <Button variant="outline" size="sm" className="w-fit" disabled={dirty || pending} onClick={() => forget.mutate()}>{t("agent.config.forget")}</Button> : null}
      <SwitchRow id="agent-workspace-access" label={t("agent.config.workspaceAccess")} hint={t("agent.config.workspaceHint")}
        checked={value.workspace_access} onCheckedChange={(checked) => set("workspace_access", checked)} disabled={pending} />
      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <Field label={t("agent.controls.reasoning")} hint={t("agent.preferences.reasoningHint")} htmlFor="agent-reasoning">
          <ThinkingSelect id="agent-reasoning" value={value.reasoning_effort} capability={capability} disabled={pending} onChange={(next) => set("reasoning_effort", next)} />
          <p className="mt-1 text-xs text-muted-foreground">{t(`agent.controls.${capability?.capability_source ?? "unknown"}`)}</p>
        </Field>
        <Field label={t("agent.controls.mode")} hint={t("agent.preferences.modeHint")} htmlFor="agent-execution-mode">
          <SimpleSelect id="agent-execution-mode" value={value.execution_mode} disabled={pending} onValueChange={(next) => set("execution_mode", next)} options={[{ value: "restricted", label: t("agent.controls.restricted") }, { value: "yolo", label: t("agent.controls.yolo") }]} />
        </Field>
      </div>
      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <Field label={t("agent.preferences.titleMode")} htmlFor="agent-title-mode">
          <SimpleSelect id="agent-title-mode" value={value.title_mode} disabled={pending} onValueChange={(next) => set("title_mode", next)} options={[{ value: "message", label: t("agent.preferences.titleMessage") }, { value: "model", label: t("agent.preferences.titleModelMode") }]} />
        </Field>
        <Field label={t("agent.preferences.titleModel")} hint={t("agent.preferences.titleModelHint")} htmlFor="agent-title-model">
          <Input id="agent-title-model" list="agent-detected-models" value={value.title_model ?? ""} placeholder={value.model} disabled={pending} maxLength={200} onChange={(e) => set("title_model", e.target.value || null)} spellCheck={false} />
        </Field>
      </div>
      <Field label={t("agent.preferences.suggestions")} hint={t("agent.preferences.titleCost")} htmlFor="agent-prompt-suggestions">
        <SimpleSelect id="agent-prompt-suggestions" value={value.prompt_suggestions} disabled={pending} onValueChange={(next) => set("prompt_suggestions", next)} options={[{ value: "off", label: t("agent.preferences.suggestionsOff") }, { value: "presets", label: t("agent.preferences.suggestionsPresets") }, { value: "model", label: t("agent.preferences.suggestionsModel") }]} />
      </Field>
      {value.provider === "anthropic" ? <Field label={t("agent.cache.setting")} hint={t("agent.cache.settingHint")} htmlFor="agent-prompt-cache">
        <SimpleSelect id="agent-prompt-cache" value={value.prompt_cache} disabled={pending} onValueChange={(next) => set("prompt_cache", next)} options={(["off", "5m", "1h"] as const).map((mode) => ({ value: mode, label: t(`agent.cache.${mode}`) }))} />
      </Field> : null}
      <p className="border-t pt-4 text-[13px] leading-relaxed text-muted-foreground">{t("agent.config.dataHint")}</p>
    </SettingsCard>
  );
}
