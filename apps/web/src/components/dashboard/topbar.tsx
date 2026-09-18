import { cn } from "@repo/ui/lib/utils"
import { Wordmark } from "@/components/brand/wordmark"
import { ModeToggle } from "@/components/common/mode-toggle"
import { ProfileMenu } from "@/components/dashboard/profile-menu"
import { SidebarSheet } from "@/components/dashboard/sidebar-sheet"
import type { SessionUser } from "@/lib/auth"

export function Topbar({
  user,
  role,
  className,
}: {
  user: SessionUser
  role: string
  className?: string
}) {
  return (
    <header
      className={cn(
        "bg-background flex items-center gap-2 border-b px-4 py-3",
        className,
      )}
    >
      <SidebarSheet user={user} role={role} />
      <Wordmark />
      <div className="ml-auto flex items-center gap-3">
        <ModeToggle />
        <ProfileMenu user={user} />
      </div>
    </header>
  )
}
