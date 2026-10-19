import { cva, type VariantProps } from "class-variance-authority";

/**
 * Buttons. One look per role: `default` is the main action of a screen (one per screen or dialog), `outline` and
 * `secondary` the other actions, `ghost` quiet tools. Every variant shows hover, pressed, keyboard focus and
 * disabled the same way; a busy button keeps its size (see Button's `loading`).
 * Heights follow Windows: 32 px standard, 28 px compact (`sm`), 24 px inline (`xs`), 40 px for a lone call to action.
 */
export const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none select-none transition-[color,background-color,border-color,box-shadow,opacity] duration-(--duration-fast) ease-out focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 aria-busy:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover active:text-primary-foreground/85",
        secondary: "bg-secondary text-secondary-foreground hover:bg-card-hover active:bg-card-active",
        outline: "border border-border bg-card text-foreground shadow-[0_1px_0_0_rgb(0_0_0/0.04)] hover:bg-card-hover active:bg-card-active active:text-foreground/80",
        ghost: "text-foreground hover:bg-accent active:bg-accent-strong active:text-foreground/80",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
        success: "bg-success text-success-foreground hover:bg-success/90 active:bg-success/80",
        link: "text-primary underline-offset-4 hover:underline active:opacity-80",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 gap-1.5 px-2.5 text-[13px]",
        xs: "h-6 gap-1 rounded-[5px] px-2 text-xs",
        lg: "h-10 px-5 text-[15px]",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-xs": "size-6 rounded-[5px]",
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
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-xs leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
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
