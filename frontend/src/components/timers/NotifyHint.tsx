import { BellOff, BellRing, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useSettings, useSystemStatus } from "@/lib/queries";

/** One line under a timer: how its end is announced (a Windows notification, or why only inside TaskRadar). */
export function NotifyHint() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data: status } = useSystemStatus();
  const notify = settings?.timers?.notify ?? true;
  const supported = status?.desktop_notifications_supported ?? true;
  const noBanner = Boolean(status?.start_menu?.supported && !status.start_menu.banners);
  const Icon = !supported || !notify ? BellOff : noBanner ? TriangleAlert : BellRing;
  return (
    <p className="flex items-start gap-2 px-1 text-[13px] leading-relaxed text-muted-foreground">
      <Icon className={noBanner && supported && notify ? "mt-0.5 size-4 shrink-0 text-urgent" : "mt-0.5 size-4 shrink-0"} aria-hidden />
      <span>
        {!supported ? t("timers.notifyUnsupported") : !notify ? t("timers.notifyOff") : noBanner ? t("timers.notifyNoBanner") : t("timers.notifyHint")}{" "}
        {supported && (noBanner || !notify) ? (
          <Link to={noBanner && notify ? "/settings?section=reminders" : "/settings?section=timers"} className="font-medium text-foreground/80 hover:underline">
            {t("timers.toSettings")}
          </Link>
        ) : null}
      </span>
    </p>
  );
}
