import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

type TabsListProps = Omit<ComponentProps<typeof TabsPrimitive.List>, "className"> & { className?: string };
type TabsTriggerProps = Omit<ComponentProps<typeof TabsPrimitive.Tab>, "className"> & { className?: string };
type TabsContentProps = Omit<ComponentProps<typeof TabsPrimitive.Panel>, "className"> & { className?: string };

export function TabsList({ className, ...props }: TabsListProps) {
  return <TabsPrimitive.List className={cn("relative flex items-center", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative inline-flex min-h-9 items-center justify-center border-b-2 border-transparent px-3 text-sm text-muted outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 data-[active]:border-accent data-[active]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Panel className={cn("outline-none", className)} {...props} />;
}
