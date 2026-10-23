import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { calendarApi, displayRange } from "@/lib/calendar";
import { useTimezone } from "@/lib/hooks";

export function TaskWorkBlocks({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
  const { data } = useQuery({ queryKey: ["task-work-blocks", taskId], queryFn: () => calendarApi.taskBlocks(taskId) });
  return <section className="grid gap-2 border-t pt-3">
    <h3 className="flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="size-4" />{t("workbench.work")}</h3>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.keepDeadline")}</p>
    {data?.map((block) => <Link key={block.id} className="text-xs text-primary hover:underline" to={`/calendar?date=${block.start.slice(0, 10)}&task=${taskId}`}>{displayRange(block.start, block.end, false, timezone, i18n.language)}</Link>)}
    <Button variant="outline" size="sm" className="w-fit" asChild><Link to={`/calendar?task=${taskId}&plan=1`}>{t("workbench.newBlock")}</Link></Button>
  </section>;
}
