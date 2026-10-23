import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { BUFFER_KINDS, MAX_BUFFER_MINUTES, NO_BUFFER, bufferSummary, bufferTarget, buffersApi, type Buffer, type BufferKind, type ItemBuffer } from "@/lib/buffers";
import type { CalendarItem } from "@/lib/calendar";
import { useAction } from "@/lib/queries";
import { cn } from "@/lib/utils";

const minutes = (value: number) => Number.isNaN(value) ? 0 : Math.min(MAX_BUFFER_MINUTES, Math.max(0, Math.round(value)));

/** Minutes and use (preparation, commute, rest) of the time reserved before and after an item, one row each. */
export function BufferFields({ value, onChange, titled = true }: { value?: Buffer | null; onChange: (next: Buffer) => void; titled?: boolean }) {
  const { t } = useTranslation();
  const buffer = value ?? NO_BUFFER;
  const set = <K extends keyof Buffer>(key: K, next: Buffer[K]) => onChange({ ...buffer, [key]: next });
  return <fieldset className="grid gap-2">
    <legend className={cn("mb-1 text-sm font-medium", !titled && "sr-only")}>{t("workbench.bufferTitle")}</legend>
    {(["before", "after"] as const).map((side) => <div key={side} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="w-10 shrink-0 text-muted-foreground" aria-hidden>{t(side === "before" ? "workbench.bufferBeforeShort" : "workbench.bufferAfterShort")}</span>
      <Input type="number" inputMode="numeric" min={0} max={MAX_BUFFER_MINUTES} step={5} className="w-20 tabular-nums"
        aria-label={t(side === "before" ? "workbench.bufferBefore" : "workbench.bufferAfter")}
        value={buffer[`${side}_minutes`]} onChange={(e) => set(`${side}_minutes`, minutes(e.target.valueAsNumber))} />
      <span className="text-muted-foreground" aria-hidden>{t("workbench.minutesUnit")}</span>
      <div className="w-28">
        <select className="calendar-select" aria-label={t(side === "before" ? "workbench.bufferBeforeKind" : "workbench.bufferAfterKind")}
          value={buffer[`${side}_kind`]} onChange={(e) => set(`${side}_kind`, e.target.value as BufferKind)}>
          {BUFFER_KINDS.map((kind) => <option key={kind} value={kind}>{t(`workbench.kind_${kind}`)}</option>)}
        </select>
      </div>
    </div>)}
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.bufferHint")}</p>
  </fieldset>;
}

/** Buffers of an existing item, saved locally at once; works for read-only and recurring meetings too. */
export function ItemBuffers({ item }: { item: CalendarItem }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ItemBuffer | null>(item.buffer ?? null);
  const [value, setValue] = useState<Buffer | null>(null);
  const [series, setSeries] = useState(current?.series ?? false);
  const recurring = item.kind === "google" && !!item.remote?.recurringEventId;
  const save = useAction(() => buffersApi.save(bufferTarget(item), value ?? NO_BUFFER, recurring && series), {
    success: t("workbench.bufferSaved"),
    onSuccess: (result) => { setCurrent(result.buffer); setValue(null); },
  });
  return <section className="grid gap-3 rounded-md border p-3 text-sm" aria-label={t("workbench.bufferLabel")}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium">{t("workbench.bufferLabel")}</p>
        <p className="text-muted-foreground">{bufferSummary(t, current)}{current?.series ? ` · ${t("workbench.bufferFromSeries")}` : ""}</p>
      </div>
      {value === null ? <Button size="xs" variant="outline" onClick={() => { setValue(current ?? NO_BUFFER); setSeries(current?.series ?? false); }}>{t("workbench.bufferEdit")}</Button> : null}
    </div>
    {value !== null ? <>
      <BufferFields value={value} onChange={setValue} titled={false} />
      {recurring ? <label className="flex items-center gap-2"><input type="checkbox" checked={series} onChange={(e) => setSeries(e.target.checked)} />{t("workbench.bufferSeries")}</label> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t("workbench.bufferSave")}</Button>
        <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setValue(null)}>{t("common.cancel")}</Button>
      </div>
    </> : null}
  </section>;
}
