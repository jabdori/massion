import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

type TooltipContentProps = Omit<ComponentProps<typeof TooltipPrimitive.Popup>, "className"> & {
  className?: string;
  side?: ComponentProps<typeof TooltipPrimitive.Positioner>["side"];
  sideOffset?: number;
};

export function TooltipContent({ className, side = "right", sideOffset = 8, ...props }: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn("rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-primary", className)}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
