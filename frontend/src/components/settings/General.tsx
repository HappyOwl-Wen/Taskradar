import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Field, Input, SwitchRow } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { LANGUAGES, rememberLanguage, type Language } from "@/i18n";
import { api } from "@/lib/api";
import { isDesktopApp } from "@/lib/desktop";
import { errorMessage } from "@/lib/errors";
import { useSection } from "@/lib/settings";
import { useTheme, type Theme } from "@/lib/theme";
import type { Settings } from "@/lib/types";
import { SaveBar, SettingsCard } from "./common";

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
      {isDesktopApp() ? (
        <SwitchRow
          id="set-close-to-tray"
          label={t("settings.general.closeToTray")}
          hint={t("settings.general.closeToTrayHint")}
          checked={section.value.close_to_tray}
          onCheckedChange={(c) => section.set("close_to_tray", c)}
        />
      ) : null}
    </SettingsCard>
  );
}
