import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";

export function SettingsCard({
  id,
  title,
  description,
  children,
  footer,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // A group of settings on a quiet panel (no box in a box): title, the fields, and its own Save at the bottom.
  return (
    <section id={id} className="grid scroll-mt-20 rounded-lg bg-subtle" aria-labelledby={`${id}-title`}>
      <header className="grid gap-1 px-5 pt-4 pb-4">
        <h2 id={`${id}-title`} className="text-section font-semibold">
          {title}
        </h2>
        {description ? <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </header>
      <div className="grid gap-5 px-5 pb-5">{children}</div>
      {footer ? <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">{footer}</div> : null}
    </section>
  );
}

export function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      {dirty ? (
        <>
          <span className="mr-auto text-[13px] font-medium text-urgent" role="status">
            {t("settings.unsavedBadge")}
          </span>
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            {t("common.reset")}
          </Button>
        </>
      ) : null}
      <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
        {saving ? t("common.saving") : t("common.save")}
      </Button>
    </>
  );
}

export function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className="max-w-40 tabular-nums"
      />
    </Field>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}
