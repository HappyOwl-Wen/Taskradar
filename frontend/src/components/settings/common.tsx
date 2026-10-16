import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader className="pb-4">
        <div className="grid gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="max-w-2xl leading-relaxed">{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">{children}</CardContent>
      {footer ? <CardFooter className="justify-end">{footer}</CardFooter> : null}
    </Card>
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
