import { useEffect, useState } from "react"
import { useLocation } from "@tanstack/react-router"
import { MenuIcon, XIcon } from "lucide-react"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
} from "@repo/ui/components/sheet"
import { Wordmark } from "@/components/brand/wordmark"
import { ModeToggle } from "@/components/common/mode-toggle"
import { ProfileMenu } from "@/components/dashboard/profile-menu"
import { SidebarNav } from "@/components/dashboard/sidebar"
import type { SessionUser } from "@/lib/auth"

/**
 * Mobile navigation. The desktop rail is hidden below `lg`, which used to leave
 * phones with no way to reach the other pages at all.
 */
export function SidebarSheet({
  user,
  role,
}: {
  user: SessionUser
  role: string
}) {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()

  // A link tap already closes it; this covers back/forward and programmatic nav.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open navigation"
        className="hover:bg-muted focus-visible:ring-ring/50 -ml-2.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:ring-3 focus-visible:outline-none"
      >
        <MenuIcon className="size-5" aria-hidden />
      </SheetTrigger>
      <SheetContent
        initialFocus={false}
        className="px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center justify-between gap-2">
          <Wordmark className="mx-2.5" />
          <SheetClose
            aria-label="Close navigation"
            className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-sidebar-ring/50 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:ring-3 focus-visible:outline-none"
          >
            <XIcon className="size-5" aria-hidden />
          </SheetClose>
        </div>
        <SidebarNav
          role={role}
          className="mt-6"
          itemClassName="h-11"
          layoutId="sidebar-sheet-active"
          onNavigate={() => setOpen(false)}
        />
        <div className="mt-auto flex items-center justify-between px-1.5">
          <ModeToggle />
          <ProfileMenu user={user} side="top" align="end" />
        </div>
      </SheetContent>
    </Sheet>
  )
}
