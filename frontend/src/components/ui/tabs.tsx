import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

type Variant = "pill" | "underline";

const LIST: Record<Variant, string> = {
  pill: "inline-flex h-8 w-fit items-center rounded-md bg-muted p-[3px] text-muted-foreground",
  underline: "flex w-full items-end gap-1 overflow-x-auto overflow-y-hidden text-muted-foreground",
};

const TRIGGER: Record<Variant, string> = {
  pill: "h-full rounded-[5px] px-3 hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
  underline:
    "-mb-px border-b-2 border-transparent px-2 pt-1 pb-2 hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground sm:px-2.5",
};

export function TabsList({ className, variant = "pill", ...props }: ComponentProps<typeof TabsPrimitive.List> & { variant?: Variant }) {
  return <TabsPrimitive.List data-variant={variant} className={cn(LIST[variant], className)} {...props} />;
}

export function TabsTrigger({ className, variant = "pill", ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { variant?: Variant }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-[color,border-color,background-color] duration-(--duration-fast) outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45",
        TRIGGER[variant],
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />;
}

/** Small count next to a tab label. */
export function TabCount({ value, active }: { value: number | undefined; active?: boolean }) {
  return (
    <span className={cn("rounded-full px-1.5 text-xs font-medium tabular-nums", active ? "bg-selected text-selected-foreground" : "bg-muted text-muted-foreground")}>
      {value ?? 0}
    </span>
  );
}
