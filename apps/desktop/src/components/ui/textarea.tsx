import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-10 w-full resize-none border-0 bg-transparent text-sm leading-6 text-primary outline-none placeholder:text-muted focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}
