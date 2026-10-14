import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { useAction } from "./queries";
import type { Settings } from "./types";

type SettingsChanges = Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>;

/**
 * Local draft for one settings section: edits are kept as overrides on top of the saved values
 * and sent together when the user clicks "save".
 */
export function useSection<K extends keyof Settings>(settings: Settings, key: K) {
  const { t } = useTranslation();
  const [changes, setChanges] = useState<Partial<Settings[K]>>({});
  const value = { ...settings[key], ...changes } as Settings[K];
  const mutation = useAction(() => api.updateSettings({ [key]: changes } as SettingsChanges), {
    success: t("common.saved"),
    onSuccess: () => setChanges({}),
  });
  return {
    value,
    set: <F extends keyof Settings[K]>(field: F, next: Settings[K][F]) => setChanges((c) => ({ ...c, [field]: next })),
    dirty: Object.keys(changes).length > 0,
    save: () => mutation.mutate(undefined),
    saving: mutation.isPending,
    reset: () => setChanges({}),
  };
}

export type Section<K extends keyof Settings> = ReturnType<typeof useSection<K>>;
