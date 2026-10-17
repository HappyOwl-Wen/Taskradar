import type { VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./variants";

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * The action is running: a spinner replaces the content, the button keeps its size and takes no clicks.
   * Pass it (also as `false`) on buttons that can be busy, so that their layout never changes.
   */
  loading?: boolean;
}

export function Button({ className, variant, size, asChild = false, loading, type, disabled, children, ...props }: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      data-slot="button"
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading === undefined ? (
        children
      ) : (
        <>
          <span className={cn("inline-flex items-center gap-[inherit]", loading && "invisible")}>{children}</span>
          {loading ? <LoaderCircle className="absolute animate-spin" aria-hidden /> : null}
        </>
      )}
    </button>
  );
}
