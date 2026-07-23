import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "accent" | "neutral" | "success" | "danger";
};

const tones = {
  accent: "border-accent/70 text-accent",
  neutral: "border-border text-secondary",
  success: "border-success/40 text-success",
  danger: "border-danger/40 text-danger",
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
