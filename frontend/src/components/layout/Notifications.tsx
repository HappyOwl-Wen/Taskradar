import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { useAction, useNotifications } from "@/lib/queries";
import type { NotificationItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_DOT: Record<NotificationItem["level"], string> = {
  overdue: "bg-overdue",
  urgent: "bg-urgent",
  high: "bg-high",
  upcoming: "bg-upcoming",
  info: "bg-primary",
  error: "bg-destructive",
};

export function NotificationsMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useNotifications();
  const markRead = useAction((id: number | undefined) => api.markRead(id));
  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];
  const unreadLevels = new Set(items.filter((i) => !i.read).map((i) => i.level));
  const badgeTone =
    unreadLevels.has("overdue") || unreadLevels.has("error")
      ? "bg-overdue text-white"
      : unreadLevels.has("urgent") || unreadLevels.has("high")
        ? "bg-urgent text-white"
        : "bg-muted-foreground text-card";

  const openItem = (item: NotificationItem) => {
    if (!item.read) markRead.mutate(item.id);
    if (item.task_id) {
      setOpen(false);
      navigate(`/tasks/${item.task_id}`);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="touch-target relative" aria-label={`${t("topbar.notifications")} (${unread})`}>
          <Bell />
          {unread > 0 ? (
            <span className={cn("absolute top-1 right-1 grid min-w-4 place-items-center rounded-full px-1 text-[10px] leading-4 font-semibold tabular-nums", badgeTone)}>
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">{t("topbar.notifications")}</p>
          {unread > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => markRead.mutate(undefined)} disabled={markRead.isPending}>
              <CheckCheck /> {t("topbar.markAllRead")}
            </Button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <BellOff className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">{t("topbar.noNotifications")}</p>
            <p className="text-xs text-muted-foreground">{t("topbar.noNotificationsHint")}</p>
          </div>
        ) : (
          <ul className="scrollbar-thin max-h-[26rem] overflow-y-auto py-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openItem(item)}
                  className={cn(
                    "flex w-full gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    item.read && "opacity-65",
                  )}
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", LEVEL_DOT[item.level])} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-sm leading-snug font-medium">{item.title}</span>
                    {item.body ? <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span> : null}
                    <span className="text-[11px] text-muted-foreground">{formatRelativeTime(item.created_at, i18n.language)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
