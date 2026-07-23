import * as React from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof PanelGroup>) {
  return <PanelGroup data-slot="resizable-panel-group" className={cn("flex h-full w-full", className)} {...props} />;
}

function ResizablePanel(props: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  withHandle = false,
  ...props
}: React.ComponentProps<typeof PanelResizeHandle> & { withHandle?: boolean }) {
  return (
    <PanelResizeHandle
      data-slot="resizable-handle"
      className={cn("group relative flex w-px items-center justify-center bg-border outline-none transition-colors hover:bg-control focus-visible:bg-accent data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full", className)}
      {...props}
    >
      {withHandle ? <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground group-hover:bg-primary" /> : null}
    </PanelResizeHandle>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
