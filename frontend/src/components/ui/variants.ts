import { cva, type VariantProps } from "class-variance-authority";

/**
 * Buttons. One look per role: `default` is the main action of a screen (one per screen or dialog), `outline` and
 * `secondary` the other actions, `ghost` quiet tools. Every variant shows hover, pressed, keyboard focus and
 * disabled the same way; a busy button keeps its size (see Button's `loading`).
 * Compact glass capsules keep the dense workspace comfortable; keyboard focus remains explicit.
 */
export const buttonVariants = cva(
  "glass-control relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-sm font-medium outline-none select-none duration-(--duration-fast) ease-out focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 aria-busy:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "glass-primary bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover active:text-primary-foreground/85",
        glass: "glass-action border text-foreground hover:text-foreground active:text-foreground/85",
        secondary: "bg-secondary text-secondary-foreground hover:bg-card-hover active:bg-card-active",
        outline: "glass-outline border border-border text-foreground hover:bg-card-hover active:bg-card-active active:text-foreground/80",
        ghost: "text-foreground hover:bg-accent active:bg-accent-strong active:text-foreground/80",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
        success: "bg-success text-success-foreground hover:bg-success/90 active:bg-success/80",
        link: "text-primary underline-offset-4 hover:underline active:opacity-80",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 gap-1.5 px-2.5 text-[13px]",
        xs: "h-6 gap-1 px-2 text-xs",
        lg: "h-10 px-5 text-[15px]",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-xs": "size-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/**
 * Small states next to a title ("已逾期", "进行中"). Colour only where it carries meaning; unconfirmed tasks (of
 * earlier versions) get a dashed outline ("tentative") instead of a colour.
 */
export const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-secondary text-secondary-foreground",
        outline: "border border-border text-muted-foreground",
        primary: "bg-selected text-selected-foreground",
        overdue: "bg-overdue/10 text-overdue",
        urgent: "bg-urgent/10 text-urgent",
        high: "bg-urgent/10 text-urgent",
        upcoming: "bg-secondary text-upcoming",
        normal: "bg-secondary text-muted-foreground",
        success: "bg-success/10 text-success",
        tentative: "border border-dashed border-tentative/70 text-tentative",
        progress: "bg-progress/10 text-progress",
        waiting: "bg-waiting/10 text-waiting",
        destructive: "bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
