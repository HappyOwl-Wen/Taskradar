import { Checkbox as CheckboxPrimitive, Label as LabelPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const fieldBase =
  "glass-field w-full min-w-0 border border-input px-3 text-sm transition-[border-color,box-shadow] duration-(--duration-fast) outline-none placeholder:text-muted-foreground hover:border-foreground/45 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(fieldBase, "h-8 py-1", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(fieldBase, "min-h-20 py-2 leading-relaxed", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:opacity-50", className)}
      {...props}
    />
  );
}

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative grid size-4 shrink-0 place-content-center rounded-[4px] border border-input bg-card outline-none transition-[background-color,border-color,box-shadow] duration-(--duration-fast) after:absolute after:-inset-2 after:content-[''] hover:border-foreground/55 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center">
        {props.checked === "indeterminate" ? <Minus className="size-3" /> : <Check className="size-3" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors duration-(--duration-normal) focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="glass-switch-thumb pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-(--duration-normal) ease-out data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}

/** Label + control + optional hint, laid out consistently in settings and dialogs. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A switch with a label and description, used for boolean settings. */
export function SwitchRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="grid gap-1">
        <Label htmlFor={id} className="leading-snug">
          {label}
        </Label>
        {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}
