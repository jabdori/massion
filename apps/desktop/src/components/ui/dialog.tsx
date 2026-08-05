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
  /**
   * 오른쪽에 딱 붙는 시트로 엽니다(수신함 등). cn이 tailwind-merge가 아니라 단순 join이므로,
   * 여기서 base 클래스를 분기해야 시트가 중앙 모달의 padding·rounded·shadow와 충돌하지 않습니다.
   */
  sheet?: boolean;
};

export function DialogContent({ className, sheet = false, viewportClassName, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
      <DialogPrimitive.Viewport
        className={cn(
          "fixed inset-0 z-50 grid",
          sheet ? "place-items-stretch justify-items-end" : "place-items-center p-4",
          viewportClassName,
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            sheet
              ? "h-full bg-chrome text-primary outline-none"
              : "rounded-lg border border-line-strong bg-chrome p-5 text-primary outline-none",
            className,
          )}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
