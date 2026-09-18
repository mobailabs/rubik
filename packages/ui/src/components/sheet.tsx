import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@repo/ui/lib/utils"

function Sheet(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />
}

function SheetTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

/**
 * Side panel that slides in from an edge. Renders through a portal with a
 * backdrop, focus trap and scroll lock (Base UI handles all three).
 *
 * Only usable on small screens in practice — the dashboard hides its trigger
 * from `lg` up.
 */
function SheetContent({
  className,
  side = "right",
  children,
  ...props
}: DialogPrimitive.Popup.Props & { side?: "left" | "right" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-backdrop"
        className="data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:pointer-events-none data-[closed]:pointer-events-none fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "bg-sidebar text-sidebar-foreground data-[ending-style]:pointer-events-none data-[closed]:pointer-events-none fixed inset-y-0 z-50 flex w-[min(17rem,85vw)] flex-col shadow-xl transition-transform duration-200 ease-out motion-reduce:transition-none",
          side === "right"
            ? "border-sidebar-border data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full right-0 border-l"
            : "border-sidebar-border data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full left-0 border-r",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

export { Sheet, SheetClose, SheetContent, SheetTrigger }
