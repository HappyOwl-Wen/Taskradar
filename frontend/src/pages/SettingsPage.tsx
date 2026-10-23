import { Bell, BookOpen, Bot, Calendar, Database, Settings2, Timer, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GeneralSection } from "@/components/settings/General";
import { CalendarSection } from "@/components/settings/Google";
import { GuideSection } from "@/components/settings/Guide";
import { DataSection, RemindersSection, SystemSection } from "@/components/settings/Other";
import { TimersSection } from "@/components/settings/Timers";
import { AgentSection } from "@/components/settings/Agent";
import { ConfirmDialog } from "@/components/ui/dialog";
import { SimpleSelect } from "@/components/ui/select";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { translateKey } from "@/i18n";
import { useUnsavedChanges } from "@/lib/desktop";
import { DirtyReporter } from "@/lib/settings";
import { useSettings } from "@/lib/queries";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const SECTIONS = ["general", "guide", "reminders", "timers", "calendar", "agent", "data", "system"] as const;
type SectionKey = (typeof SECTIONS)[number];

const ICON: Record<SectionKey, LucideIcon> = {
  general: Settings2,
  guide: BookOpen,
  reminders: Bell,
  timers: Timer,
  calendar: Calendar,
  data: Database,
  system: Wrench,
  agent: Bot,
};

function isSection(value: string | null | undefined): value is SectionKey {
  return SECTIONS.includes(value as SectionKey);
}

function SectionBody({ section, settings }: { section: SectionKey; settings: Settings }) {
  switch (section) {
    case "agent":
      return <AgentSection />;
    case "general":
      return <GeneralSection settings={settings} />;
    case "guide":
      return <GuideSection />;
    case "calendar":
      return <CalendarSection settings={settings} />;
    case "reminders":
      return <RemindersSection settings={settings} />;
    case "timers":
      return <TimersSection settings={settings} />;
    case "data":
      return <DataSection />;
    case "system":
      return <SystemSection />;
  }
}

/**
 * One settings category at a time: picking a category shows exactly that content, so nothing
 * unrelated has to be scrolled past. Unsaved edits are never dropped silently, whichever way the user
 * leaves: another category, the sidebar, the search, the browser's back button or closing the window.
 */
export default function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { data: settings, error, isLoading, refetch } = useSettings();
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const handledOAuth = useRef<string | null>(null);

  const legacy = location.hash.slice(1);
  const section: SectionKey = isSection(params.get("section")) ? (params.get("section") as SectionKey) : isSection(legacy) ? legacy : "general";

  // Old links (/settings#gmail) keep working; the address is normalised to ?section=.
  useEffect(() => {
    if (isSection(legacy)) navigate({ pathname: "/settings", search: `?section=${legacy}` }, { replace: true });
  }, [legacy, navigate]);

  // Result of the Google OAuth redirect in a browser tab (?connected=calendar or ?oauth_error=code).
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("oauth_error");
    if (!connected && !failed) return;
    const key = params.toString();
    if (handledOAuth.current === key) return;
    handledOAuth.current = key;
    if (connected === "calendar") toast.success(t("settings.calendar.connectedToast"));
    if (failed) toast.error(t("settings.oauthError", { code: translateKey(`errors.${failed}`, failed) }), { duration: 10000 });
    setParams({ section: connected === "calendar" || failed ? "calendar" : section }, { replace: true });
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

  // Closing the window (desktop app) or the tab with unsaved edits asks first.
  useUnsavedChanges(dirty.size > 0);

  // Every in-app navigation away from the current drafts (another category or another page) asks first.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty.size > 0 && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );

  const select = (next: SectionKey) => {
    if (next !== section) setParams({ section: next }, { replace: false });
  };

  return (
    <div className="grid grid-cols-1 gap-5">
      <header className="grid gap-0.5">
        <h1 className="text-page font-semibold">{t("settings.title")}</h1>
        <p className="text-[13px] text-muted-foreground">{t("settings.description")}</p>
      </header>

      {/* Phones: a select (seven categories do not fit in one row); tablets: tabs; desktop: side navigation. */}
      <SimpleSelect
        className="sm:hidden"
        value={section}
        onValueChange={(v) => select(v)}
        ariaLabel={t("settings.title")}
        options={SECTIONS.map((s) => ({ value: s, label: t(`settings.sections.${s}`) }))}
      />
      <Tabs value={section} onValueChange={(v) => select(v as SectionKey)} className="hidden min-w-0 sm:block lg:hidden">
        <TabsList variant="underline" className="border-b">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s} value={s} variant="underline">
              {t(`settings.sections.${s}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav className="settings-navigation hidden h-fit gap-1 lg:sticky lg:top-0 lg:grid" aria-label={t("settings.title")}>
          {SECTIONS.map((s) => {
            const Icon = ICON[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => select(s)}
                aria-current={section === s ? "page" : undefined}
                className={cn(
                  "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-muted-foreground transition-colors duration-(--duration-fast) outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:bg-accent-strong",
                  section === s && "bg-accent font-medium text-foreground",
                )}
              >
                {/* The same selection mark as the main navigation. */}
                <span aria-hidden className={cn("absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary transition-opacity", section === s ? "opacity-100" : "opacity-0")} />
                <Icon className={cn("size-4", section === s && "text-primary")} />
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
        open={blocker.state === "blocked"}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title={t("settings.unsavedTitle")}
        description={t("settings.unsavedDescription")}
        confirmLabel={t("settings.discard")}
        cancelLabel={t("settings.keepEditing")}
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
