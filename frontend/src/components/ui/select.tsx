import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "glass-field flex h-8 w-full items-center justify-between gap-2 border border-input px-3 text-sm whitespace-nowrap outline-none transition-[background-color,border-color,box-shadow] duration-(--duration-fast) hover:bg-card-hover focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 data-[placeholder]:text-muted-foreground data-[state=open]:border-ring [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = "popper", sideOffset = 4, style, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        style={{ "--popup-gap": `${sideOffset}px`, ...style } as CSSProperties}
        className={cn(
          "glass-popover motion-popover relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto border text-popover-foreground",
          position === "popper" && "w-full min-w-(--radix-select-trigger-width)",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[state=checked]:font-medium",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** Convenience wrapper for the common "pick one of these values" case. */
export function SimpleSelect<T extends string>({
  value,
  onValueChange,
  options,
  id,
  className,
  disabled,
  ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  id?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
