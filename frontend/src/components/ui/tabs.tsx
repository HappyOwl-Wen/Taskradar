import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

type Variant = "pill" | "underline";

const LIST: Record<Variant, string> = {
  pill: "glass-segmented inline-flex w-fit items-center text-muted-foreground",
  underline: "flex w-full items-end gap-1 overflow-x-auto overflow-y-hidden text-muted-foreground",
};

const TRIGGER: Record<Variant, string> = {
  pill: "h-full px-3.5 hover:text-foreground data-[state=active]:text-foreground",
  underline: "h-8 px-3 hover:text-foreground data-[state=active]:text-foreground",
};

export function TabsList({ className, variant = "pill", ...props }: ComponentProps<typeof TabsPrimitive.List> & { variant?: Variant }) {
  return <TabsPrimitive.List data-variant={variant} data-selection-scope={variant === "pill" ? "segmented" : "tabs"} className={cn("liquid-tabs", LIST[variant], className)} {...props} />;
}

export function TabsTrigger({ className, variant = "pill", ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { variant?: Variant }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "liquid-option inline-flex items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-[color,border-color,background-color] duration-(--duration-fast) outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45",
        TRIGGER[variant],
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("motion-section outline-none", className)} {...props} />;
}

/** Small count next to a tab label. */
export function TabCount({ value, active }: { value: number | undefined; active?: boolean }) {
  return (
    <span className={cn("rounded-full px-1.5 text-xs font-medium tabular-nums", active ? "bg-selected text-selected-foreground" : "bg-muted text-muted-foreground")}>
      {value ?? 0}
    </span>
  );
}
