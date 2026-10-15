import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { useAction } from "./queries";
import type { Settings } from "./types";

type SettingsChanges = Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>;

/** Lets the settings page know which sections have unsaved edits (to warn before leaving them). */
export const DirtyReporter = createContext<(key: string, dirty: boolean) => void>(() => undefined);

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
  const report = useContext(DirtyReporter);
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    report(key as string, dirty);
    return () => report(key as string, false);
  }, [report, key, dirty]);
  return {
    value,
    set: <F extends keyof Settings[K]>(field: F, next: Settings[K][F]) => setChanges((c) => ({ ...c, [field]: next })),
    dirty,
    save: () => mutation.mutate(undefined),
    saving: mutation.isPending,
    reset: () => setChanges({}),
  };
}

export type Section<K extends keyof Settings> = ReturnType<typeof useSection<K>>;
