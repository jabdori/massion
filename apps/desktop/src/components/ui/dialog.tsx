import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

type DialogContentProps = Omit<ComponentProps<typeof DialogPrimitive.Popup>, "className"> & {
  className?: string;
  viewportClassName?: string;
};

export function DialogContent({ className, viewportClassName, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
      <DialogPrimitive.Viewport className={cn("fixed inset-0 z-50 grid place-items-center p-4", viewportClassName)}>
        <DialogPrimitive.Popup
          className={cn(
            "w-full max-w-md rounded-lg border border-border bg-chrome p-5 text-primary shadow-2xl outline-none",
            className,
          )}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
