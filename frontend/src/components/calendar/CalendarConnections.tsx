import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DateTime } from "luxon";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { calendarApi, type CalendarSources } from "@/lib/calendar";
import { useAction } from "@/lib/queries";

function SourceChoices({ data }: { data: CalendarSources }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(data.sources.filter((s) => s.selected).map((s) => s.id));
  const [target, setTarget] = useState(data.default_calendar_id ?? "");
  const [editing, setEditing] = useState(data.google_edit_enabled);
  const save = useAction(() => calendarApi.select(selected, target || null, editing), { success: t("workbench.selectionSaved") });
  return <div className="grid gap-3">
    <p className="text-xs text-muted-foreground">{t("workbench.selectHint")}</p>
    {data.sources.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(s.id)} onChange={(e) => {
      setSelected(e.target.checked ? [...selected, s.id] : selected.filter((id) => id !== s.id)); if (!e.target.checked && target === s.id) setTarget("");
    }} />{s.summary}{s.primary ? ` · ${t("workbench.primary")}` : ""} · {t(s.access_role === "reader" || s.access_role === "freeBusyReader" ? "workbench.readOnly" : "workbench.editable")}</label>)}
    <label className="grid gap-1.5 text-sm">{t("workbench.defaultCalendar")}<select className="rounded-md border border-input bg-card p-2" value={target} onChange={(e) => setTarget(e.target.value)}>
      <option value="">{t("workbench.none")}</option>{data.sources.filter((s) => selected.includes(s.id) && ["owner", "writer"].includes(s.access_role)).map((s) => <option key={s.id} value={s.id}>{s.summary}</option>)}
    </select></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!data.capabilities.edit} checked={editing} onChange={(e) => setEditing(e.target.checked)} />{t("workbench.enableEditing")}</label>
    <Button className="w-fit" variant="outline" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t("workbench.saveSelection")}</Button>
  </div>;
}

export function CalendarConnections({ onConnect, busy, ready }: { onConnect: (tier: "read" | "edit") => void; busy: boolean; ready: boolean }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ["calendar-sources"], queryFn: calendarApi.sources });
  const [tier, setTier] = useState<"read" | "edit" | null>(null);
  const refresh = useAction(() => calendarApi.refresh(DateTime.now().startOf("month").toISODate()!, DateTime.now().plus({ months: 1 }).startOf("month").toISODate()!));
  return <section className="grid gap-3 rounded-lg border bg-subtle p-4">
    <h3 className="text-sm font-semibold">{t("workbench.title")}</h3>
    <p className="text-xs text-muted-foreground">{t(data?.capabilities.edit ? "workbench.accessEdit" : data?.capabilities.read ? "workbench.accessRead" : "workbench.accessApp")}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!ready || busy} onClick={() => setTier("read")}>{t("workbench.readAccess")}</Button><Button variant="outline" size="sm" disabled={!ready || busy} onClick={() => setTier("edit")}>{t("workbench.editAccess")}</Button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.filtersHint")}</p>
    {data?.capabilities.connected ? <Button variant="outline" size="sm" className="w-fit" loading={refresh.isPending} onClick={() => refresh.mutate(undefined)}>{t("workbench.refresh")}</Button> : null}
    {data && data.sources.length > 0 ? <SourceChoices key={JSON.stringify(data)} data={data} /> : null}
    <ConfirmDialog open={tier !== null} onOpenChange={(open) => !open && setTier(null)} title={t(tier === "edit" ? "workbench.editAccess" : "workbench.readAccess")} description={t(tier === "edit" ? "workbench.editConsent" : "workbench.readConsent")} confirmLabel={t("workbench.authorize")} cancelLabel={t("common.cancel")} onConfirm={() => { if (tier) onConnect(tier); setTier(null); }} />
  </section>;
}
