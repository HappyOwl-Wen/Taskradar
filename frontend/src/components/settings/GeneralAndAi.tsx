import { KeyRound, PlugZap, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Label, SwitchRow } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { LANGUAGES, rememberLanguage, type Language } from "@/i18n";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useAction, useSystemStatus } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import { useTheme, type Theme } from "@/lib/theme";
import type { Settings } from "@/lib/types";
import { NumberField, SaveBar, SettingsCard } from "./common";

export function GeneralSection({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useTheme();
  const section = useSection(settings, "general");
  const persist = (changes: { language?: Language; theme?: Theme }) =>
    api.updateSettings({ general: changes }).catch((error: unknown) => toast.error(errorMessage(error)));
  return (
    <SettingsCard
      id="general"
      title={t("settings.sections.general")}
      footer={<SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t("settings.general.language")} htmlFor="set-language">
          <SimpleSelect
            id="set-language"
            value={(i18n.language as Language) ?? "zh-CN"}
            onValueChange={(lang) => {
              void i18n.changeLanguage(lang);
              rememberLanguage(lang);
              void persist({ language: lang });
            }}
            options={LANGUAGES}
          />
        </Field>
        <Field label={t("settings.general.theme")} htmlFor="set-theme">
          <SimpleSelect
            id="set-theme"
            value={theme}
            onValueChange={(next) => {
              setTheme(next);
              void persist({ theme: next });
            }}
            options={[
              { value: "system", label: t("topbar.themeSystem") },
              { value: "light", label: t("topbar.themeLight") },
              { value: "dark", label: t("topbar.themeDark") },
            ]}
          />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t("settings.general.instantHint")}</p>
      <Field label={t("settings.general.timezone")} hint={t("settings.general.timezoneHint")} htmlFor="set-tz">
        <Input id="set-tz" value={section.value.timezone} onChange={(e) => section.set("timezone", e.target.value)} className="max-w-72 font-mono" />
      </Field>
    </SettingsCard>
  );
}

function ApiKeyField() {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const [key, setKey] = useState("");
  const save = useAction(() => api.setApiKey(key.trim()), { success: t("settings.ai.keySaved"), onSuccess: () => setKey("") });
  const remove = useAction(() => api.deleteApiKey(), { success: t("settings.ai.keyRemoved") });
  const llm = status?.llm;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate(undefined);
  };
  return (
    <div className="grid gap-2">
      <Label htmlFor="set-apikey">{t("settings.ai.apiKey")}</Label>
      <p className="flex items-center gap-2 text-sm">
        <KeyRound className="size-4 text-muted-foreground" />
        {llm?.api_key_configured ? (
          <span className="text-success">
            {t("settings.ai.apiKeyConfigured", {
              source: t(`settings.ai.apiKeySources.${llm.api_key_source === "environment" ? "environment" : "credential_store"}`),
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("settings.ai.apiKeyMissing")}</span>
        )}
      </p>
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <Input
          id="set-apikey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("settings.ai.apiKeyPlaceholder")}
          className="max-w-md flex-1 font-mono"
        />
        <Button type="submit" size="sm" disabled={!key.trim() || save.isPending}>
          {t("settings.ai.saveKey")}
        </Button>
        {llm?.api_key_source === "credential_store" ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>
            <Trash2 /> {t("settings.ai.removeKey")}
          </Button>
        ) : null}
      </form>
    </div>
  );
}

export function AiSection({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const { data: status } = useSystemStatus();
  const section = useSection(settings, "llm");
  const v = section.value;
  const test = useAction(() => api.testLlm(), {
    success: (r) => t("settings.ai.testOk", { model: r.model, ms: r.latency_ms }),
    invalidate: false,
  });
  const enabled = v.provider !== "none";
  const mode = status?.agent_mode ?? "rules";
  return (
    <SettingsCard
      id="ai"
      title={t("settings.sections.ai")}
      description={t("settings.ai.intro")}
      footer={
        <>
          {enabled ? (
            <Button variant="outline" size="sm" onClick={() => test.mutate(undefined)} disabled={test.isPending || section.dirty}>
              <PlugZap /> {t("settings.ai.test")}
            </Button>
          ) : null}
          <SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />
        </>
      }
    >
      <p className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("settings.ai.activeMode")}:</span>
        <Badge tone={mode === "llm" ? "primary" : "success"}>
          {mode === "llm" ? <Sparkles /> : <ShieldCheck />}
          {mode === "llm" ? t("agentMode.llm") : t("agentMode.rules")}
        </Badge>
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t("settings.ai.provider")} htmlFor="set-provider">
          <SimpleSelect
            id="set-provider"
            value={v.provider}
            onValueChange={(p) => section.set("provider", p)}
            options={(["none", "openai", "openai_compatible"] as const).map((p) => ({ value: p, label: t(`settings.ai.providers.${p}`) }))}
          />
        </Field>
        {enabled ? (
          <Field label={t("settings.ai.model")} hint={t("settings.ai.modelHint")} htmlFor="set-model">
            <Input id="set-model" value={v.model} onChange={(e) => section.set("model", e.target.value)} className="font-mono" />
          </Field>
        ) : null}
      </div>
      {v.provider === "openai_compatible" ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t("settings.ai.baseUrl")} hint={t("settings.ai.baseUrlHint")} htmlFor="set-baseurl">
            <Input
              id="set-baseurl"
              value={v.base_url ?? ""}
              placeholder="https://…/v1"
              onChange={(e) => section.set("base_url", e.target.value || null)}
              className="font-mono"
            />
          </Field>
          <Field label={t("settings.ai.structuredMode")} htmlFor="set-structured">
            <SimpleSelect
              id="set-structured"
              value={v.structured_mode}
              onValueChange={(m) => section.set("structured_mode", m)}
              options={(["json_schema", "json_object"] as const).map((m) => ({ value: m, label: t(`settings.ai.structuredModes.${m}`) }))}
            />
          </Field>
        </div>
      ) : null}
      {enabled ? (
        <>
          <ApiKeyField />
          <div className="grid gap-3 rounded-lg bg-urgent/8 p-4">
            <p className="text-sm font-semibold">{t("settings.ai.consentTitle")}</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.ai.consentBody")}</p>
            <Label className="items-start font-normal leading-snug">
              <Checkbox checked={v.cloud_consent} onCheckedChange={(c) => section.set("cloud_consent", c === true)} className="mt-0.5" />
              {t("settings.ai.consent")}
            </Label>
            {settings.llm.cloud_consent && settings.llm.consent_at ? (
              <p className="text-xs text-muted-foreground">{t("settings.ai.consentGiven", { time: formatDateTime(settings.llm.consent_at, i18n.language, settings.general.timezone) })}</p>
            ) : null}
          </div>
          <div className="grid gap-3">
            <p className="text-sm font-semibold">{t("settings.ai.minimization")}</p>
            <SwitchRow id="set-redact" label={t("settings.ai.redact")} checked={v.redact_identifiers} onCheckedChange={(c) => section.set("redact_identifiers", c)} />
            <SwitchRow id="set-prefilter" label={t("settings.ai.prefilter")} checked={v.prefilter} onCheckedChange={(c) => section.set("prefilter", c)} />
            <SwitchRow
              id="set-semantic"
              label={t("settings.ai.semanticDedup")}
              checked={v.use_semantic_dedup}
              onCheckedChange={(c) => section.set("use_semantic_dedup", c)}
            />
            <NumberField
              id="set-maxchars"
              label={t("settings.ai.maxChars")}
              value={v.max_input_chars}
              min={1000}
              max={100000}
              step={500}
              onChange={(n) => section.set("max_input_chars", n)}
            />
          </div>
        </>
      ) : null}
    </SettingsCard>
  );
}
