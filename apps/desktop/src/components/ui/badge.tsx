import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "accent" | "neutral" | "success" | "danger";
};

const tones = {
  accent: "border-accent/70 text-accent",
  neutral: "border-border text-secondary",
  success: "border-line-strong text-fg-3",
  danger: "border-danger/40 text-danger",
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-[5px] border px-2.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
