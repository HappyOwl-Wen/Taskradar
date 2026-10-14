import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AiSection, GeneralSection } from "@/components/settings/GeneralAndAi";
import { CalendarSection, GmailSection } from "@/components/settings/Google";
import { DataSection, PolicySection, RemindersSection, SystemSection } from "@/components/settings/Other";
import { ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { useGoogle, useSettings, useSystemStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

const SECTIONS = ["general", "ai", "gmail", "calendar", "reminders", "policy", "system", "data"] as const;

/** Result of the Google OAuth redirect (?connected=gmail or ?oauth_error=code). */
function useOAuthResult() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("oauth_error");
    if (!connected && !failed) return;
    const key = params.toString();
    if (handled.current === key) return;
    handled.current = key;
    if (connected === "gmail" || connected === "calendar") toast.success(t(`settings.oauthConnected.${connected}`));
    if (failed) toast.error(t("settings.oauthError", { code: translateKey(`errors.${failed}`, failed) }), { duration: 10000 });
    setParams({}, { replace: true });
  }, [params, setParams, t]);
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { data: settings, error, isLoading, refetch } = useSettings();
  const status = useSystemStatus();
  const google = useGoogle();
  useOAuthResult();

  // Jump to #section only once every section has its data; otherwise sections above it are still
  // loading and push the target further down after the scroll.
  const laidOut = Boolean(settings) && !status.isPending && !google.isPending;
  useEffect(() => {
    if (!location.hash || !laidOut) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [location.hash, laidOut]);

  return (
    <div className="grid gap-6">
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <nav className="sticky top-20 hidden h-fit gap-0.5 lg:grid" aria-label={t("settings.title")}>
          {SECTIONS.map((s) => (
            <a
              key={s}
              href={`#${s}`}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                location.hash === `#${s}` && "bg-accent text-foreground",
              )}
            >
              {t(`settings.sections.${s}`)}
            </a>
          ))}
        </nav>
        <div className="grid min-w-0 gap-6">
          {isLoading ? <LoadingRows rows={6} /> : null}
          {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
          {settings ? (
            <>
              <GeneralSection settings={settings} />
              <AiSection settings={settings} />
              <GmailSection settings={settings} />
              <CalendarSection settings={settings} />
              <RemindersSection settings={settings} />
              <PolicySection settings={settings} />
              <SystemSection />
              <DataSection />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
