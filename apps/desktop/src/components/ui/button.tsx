import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

const variants = {
  primary: "border-accent bg-accent text-accent-ink hover:bg-[#f2b536]",
  outline: "border-control bg-transparent text-primary hover:border-secondary hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-secondary hover:bg-surface-2 hover:text-primary",
  danger: "border-danger/50 bg-danger/10 text-danger hover:bg-danger/15",
};

const sizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  icon: "size-9 p-0",
};

export function Button({ className, size = "md", type = "button", variant = "outline", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium outline-none transition-[background-color,border-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-45 active:translate-y-px",
        variants[variant],
        sizes[size],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
