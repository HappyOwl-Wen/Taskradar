import { Bell, Bot, Calendar, Database, Mail, Settings2, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AiSection, GeneralSection } from "@/components/settings/GeneralAndAi";
import { CalendarSection, GmailSection } from "@/components/settings/Google";
import { DataSection, PolicySection, RemindersSection, SystemSection } from "@/components/settings/Other";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { translateKey } from "@/i18n";
import { DirtyReporter } from "@/lib/settings";
import { useSettings } from "@/lib/queries";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const SECTIONS = ["general", "ai", "gmail", "calendar", "reminders", "policy", "data", "system"] as const;
type SectionKey = (typeof SECTIONS)[number];

const ICON: Record<SectionKey, LucideIcon> = {
  general: Settings2,
  ai: Bot,
  gmail: Mail,
  calendar: Calendar,
  reminders: Bell,
  policy: SlidersHorizontal,
  data: Database,
  system: Wrench,
};

function isSection(value: string | null | undefined): value is SectionKey {
  return SECTIONS.includes(value as SectionKey);
}

function SectionBody({ section, settings }: { section: SectionKey; settings: Settings }) {
  switch (section) {
    case "general":
      return <GeneralSection settings={settings} />;
    case "ai":
      return <AiSection settings={settings} />;
    case "gmail":
      return <GmailSection settings={settings} />;
    case "calendar":
      return <CalendarSection settings={settings} />;
    case "reminders":
      return <RemindersSection settings={settings} />;
    case "policy":
      return <PolicySection settings={settings} />;
    case "data":
      return <DataSection />;
    case "system":
      return <SystemSection />;
  }
}

/**
 * One settings category at a time: picking a category shows exactly that content, so nothing
 * unrelated has to be scrolled past. Unsaved edits are never dropped silently.
 */
export default function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { data: settings, error, isLoading, refetch } = useSettings();
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<SectionKey | null>(null);
  const handledOAuth = useRef<string | null>(null);

  const legacy = location.hash.slice(1);
  const section: SectionKey = isSection(params.get("section")) ? (params.get("section") as SectionKey) : isSection(legacy) ? legacy : "general";

  // Old links (/settings#gmail) keep working; the address is normalised to ?section=.
  useEffect(() => {
    if (isSection(legacy)) navigate({ pathname: "/settings", search: `?section=${legacy}` }, { replace: true });
  }, [legacy, navigate]);

  // Result of the Google OAuth redirect (?connected=gmail or ?oauth_error=code).
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("oauth_error");
    if (!connected && !failed) return;
    const key = params.toString();
    if (handledOAuth.current === key) return;
    handledOAuth.current = key;
    if (connected === "gmail" || connected === "calendar") toast.success(t(`settings.oauthConnected.${connected}`));
    if (failed) toast.error(t("settings.oauthError", { code: translateKey(`errors.${failed}`, failed) }), { duration: 10000 });
    setParams({ section: connected === "gmail" || connected === "calendar" ? connected : section }, { replace: true });
  }, [params, setParams, t, section]);

  const report = useCallback((key: string, isDirty: boolean) => {
    setDirty((prev) => {
      if (prev.has(key) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Closing or reloading the window with unsaved edits asks first (the browser shows its own prompt).
  useEffect(() => {
    if (dirty.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.size]);

  const go = (next: SectionKey) => setParams({ section: next }, { replace: false });
  const select = (next: SectionKey) => {
    if (next === section) return;
    if (dirty.size > 0) setPending(next);
    else go(next);
  };

  return (
    <div className="grid gap-5">
      <header className="grid gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="text-[13px] text-muted-foreground">{t("settings.description")}</p>
      </header>

      <Tabs value={section} onValueChange={(v) => select(v as SectionKey)} className="lg:hidden">
        <TabsList variant="underline" className="border-b">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s} value={s} variant="underline">
              {t(`settings.sections.${s}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav className="hidden h-fit gap-0.5 lg:sticky lg:top-0 lg:grid" aria-label={t("settings.title")}>
          {SECTIONS.map((s) => {
            const Icon = ICON[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => select(s)}
                aria-current={section === s ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  section === s && "bg-accent font-medium text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t(`settings.sections.${s}`)}
              </button>
            );
          })}
        </nav>
        <div className="grid min-w-0 content-start gap-6">
          {isLoading ? <LoadingRows rows={6} /> : null}
          {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
          {settings ? (
            <DirtyReporter.Provider value={report}>
              <SectionBody key={section} section={section} settings={settings} />
            </DirtyReporter.Provider>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={t("settings.unsavedTitle")}
        description={t("settings.unsavedDescription")}
        confirmLabel={t("settings.discard")}
        cancelLabel={t("settings.keepEditing")}
        destructive
        onConfirm={() => {
          if (pending) go(pending);
          setPending(null);
        }}
      />
    </div>
  );
}
