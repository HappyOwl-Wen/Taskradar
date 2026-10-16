import { cva, type VariantProps } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        success: "bg-success text-white shadow-xs hover:bg-success/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 gap-1.5 rounded-md px-3 text-[13px]",
        xs: "h-7 gap-1 rounded-md px-2 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        primary: "border-primary/20 bg-selected text-selected-foreground",
        overdue: "border-overdue/25 bg-overdue/8 text-overdue",
        urgent: "border-urgent/25 bg-urgent/8 text-urgent",
        high: "border-urgent/25 bg-urgent/8 text-urgent",
        upcoming: "border-border bg-muted text-upcoming",
        normal: "border-border bg-muted text-muted-foreground",
        success: "border-success/25 bg-success/8 text-success",
        violet: "border-violet/25 bg-violet/8 text-violet",
        destructive: "border-destructive/25 bg-destructive/8 text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
