import { CalendarDays, ArrowUpRight } from "lucide-react";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { useTimezone } from "@/lib/hooks";

/** Real dates make the small calendar a useful shortcut, including across midnight and timezones. */
export function SidebarWeek() {
  const { t, i18n } = useTranslation();
  const zone = useTimezone();
  const location = useLocation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = DateTime.fromMillis(now, { zone }).setLocale(i18n.language);
  const start = today.startOf("week");
  const selectedDate = location.pathname === "/calendar" ? new URLSearchParams(location.search).get("date") ?? today.toISODate() : today.toISODate();
  const dayLink = (date: string | null) => `/calendar?date=${date}&view=timeGridDay`;
  return (
    <section className="sidebar-week" aria-label={t("workbench.today")}>
      <Link className="sidebar-week-title" to={dayLink(today.toISODate())}>
        <CalendarDays className="size-3.5" aria-hidden />
        <span>{today.toFormat(i18n.language === "zh-CN" ? "yyyy 年 M 月" : "MMMM yyyy")}</span>
        <ArrowUpRight className="ml-auto size-3.5" aria-hidden />
      </Link>
      <div className="sidebar-week-days" data-selection-scope="dates">
        {Array.from({ length: 7 }, (_, index) => {
          const day = start.plus({ days: index });
          const current = day.toISODate() === selectedDate;
          return (
            <Link key={day.toISODate()} to={dayLink(day.toISODate())} data-today={day.hasSame(today, "day") ? "true" : undefined} aria-label={day.toLocaleString(DateTime.DATE_HUGE)} aria-current={current ? "date" : undefined}>
              <span>{day.toFormat("ccccc")}</span>
              <time dateTime={day.toISODate()!}>{day.day}</time>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
