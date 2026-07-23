import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type AvatarProps = Omit<ComponentProps<typeof AvatarPrimitive.Root>, "className"> & { className?: string };
type AvatarImageProps = Omit<ComponentProps<typeof AvatarPrimitive.Image>, "className"> & { className?: string };
type AvatarFallbackProps = Omit<ComponentProps<typeof AvatarPrimitive.Fallback>, "className"> & { className?: string };

export function Avatar({ className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative inline-flex size-8 shrink-0 overflow-hidden rounded-full bg-surface-2", className)}
      {...props}
    />
  );
}

export function AvatarImage({ className, ...props }: AvatarImageProps) {
  return <AvatarPrimitive.Image className={cn("size-full object-cover", className)} {...props} />;
}

export function AvatarFallback({ className, ...props }: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback
      className={cn("flex size-full items-center justify-center text-[11px] font-semibold text-secondary", className)}
      {...props}
    />
  );
}
