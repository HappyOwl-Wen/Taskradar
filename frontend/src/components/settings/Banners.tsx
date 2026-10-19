import { CircleCheck, PanelsTopLeft, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useAction, useSystemStatus } from "@/lib/queries";

/**
 * Whether Windows shows TaskRadar's notifications as banners. It does so only when a Start menu entry carries
 * TaskRadar's app ID (the installer adds one); otherwise they go to the notification centre silently. From the
 * source or the portable version the user can add the entry here, after a question that says what is created.
 */
export function NotificationBanners() {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const [asking, setAsking] = useState<"add" | "remove" | null>(null);
  const change = useAction((enabled: boolean) => api.setStartMenu(enabled), {
    success: (r) => (r.banners ? t("settings.banners.added") : t("settings.banners.removed")),
    onSuccess: () => setAsking(null),
  });
  const entry = status?.start_menu;
  if (!entry?.supported || !status?.desktop_notifications_supported) return null;
  return (
    <div className="grid gap-2 rounded-md bg-card p-3" role="status">
      {entry.banners ? (
        <p className="flex items-start gap-2 text-[13px] leading-relaxed">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span>{t("settings.banners.on")}</span>
        </p>
      ) : (
        <>
          <p className="flex items-start gap-2 text-[13px] leading-relaxed">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-urgent" aria-hidden />
            <span>
              <span className="font-medium">{t("settings.banners.offTitle")}</span> {t("settings.banners.offHint")}
            </span>
          </p>
          <Button size="sm" className="w-fit" onClick={() => setAsking("add")}>
            <PanelsTopLeft /> {entry.present ? t("settings.banners.update") : t("settings.banners.add")}
          </Button>
        </>
      )}
      {entry.banners && entry.ours ? (
        <Button variant="ghost" size="xs" className="w-fit text-muted-foreground" onClick={() => setAsking("remove")}>
          {t("settings.banners.remove")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asking === "remove" ? t("settings.banners.removeTitle") : t("settings.banners.addTitle")}
        description={
          asking === "remove"
            ? t("settings.banners.removeDescription")
            : entry.present
              ? t("settings.banners.updateDescription")
              : t("settings.banners.addDescription")
        }
        confirmLabel={asking === "remove" ? t("settings.banners.removeConfirm") : t("settings.banners.addConfirm")}
        cancelLabel={t("common.cancel")}
        pending={change.isPending}
        onConfirm={() => change.mutate(asking !== "remove")}
      />
    </div>
  );
}
