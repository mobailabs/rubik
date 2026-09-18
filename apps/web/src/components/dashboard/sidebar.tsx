import {
  ActivityIcon,
  BarChart3Icon,
  BookOpenIcon,
  FolderIcon,
  GraduationCapIcon,
  HeadphonesIcon,
  LineChartIcon,
  ListTodoIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { MotionConfig } from "motion/react"
import { cn } from "@repo/ui/lib/utils"
import { Wordmark } from "@/components/brand/wordmark"
import { ModeToggle } from "@/components/common/mode-toggle"
import { NavItem, type NavEntry } from "@/components/dashboard/nav-item"
import { ProfileMenu } from "@/components/dashboard/profile-menu"
import type { SessionUser } from "@/lib/auth"

const ADMIN_PATH = "/dashboard/admin"

/**
 * 导航顺序：统计在最前 —— 它是登录后的落点（见 guards.ts 的 HOME_PATH），
 * 也对应「打开应用先看练得怎么样」这个使用顺序。`/dashboard`（Tasks）保留，
 * 只是往后排，它不再是默认页。
 */
const NAV: NavEntry[] = [
  { label: "统计", icon: BarChart3Icon, to: "/dashboard/stats" },
  { label: "Practice", icon: BookOpenIcon, to: "/dashboard/practice" },
  { label: "错词本", icon: GraduationCapIcon, to: "/dashboard/wb" },
  { label: "Tasks", icon: ListTodoIcon, to: "/dashboard" },
  { label: "Player", icon: HeadphonesIcon, to: "/dashboard/player" },
  { label: "Progress", icon: LineChartIcon, to: "/dashboard/progress" },
  { label: "Projects", icon: FolderIcon },
  { label: "Activity", icon: ActivityIcon },
  { label: "Admin", icon: ShieldCheckIcon, to: ADMIN_PATH },
  { label: "Settings", icon: SettingsIcon },
]

/**
 * The navigation list itself, shared by the desktop rail and the mobile sheet.
 * `layoutId` must differ per instance — two mounted copies sharing a motion
 * layout id fight over the same element.
 */
export function SidebarNav({
  role,
  className,
  itemClassName,
  layoutId = "sidebar-active",
  onNavigate,
}: {
  role: string
  className?: string
  itemClassName?: string
  layoutId?: string
  onNavigate?: () => void
}) {
  const entries =
    role === "admin" ? NAV : NAV.filter((entry) => entry.to !== ADMIN_PATH)

  return (
    <MotionConfig reducedMotion="user">
      <nav aria-label="Dashboard" className={className}>
        <ul className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <NavItem
              key={entry.label}
              {...entry}
              className={itemClassName}
              layoutId={layoutId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      </nav>
    </MotionConfig>
  )
}

export function Sidebar({
  user,
  role,
  className,
}: {
  user: SessionUser
  role: string
  className?: string
}) {
  return (
    <aside
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 flex h-svh flex-col gap-8 border-r px-4 py-6",
        className,
      )}
    >
      <Wordmark className="mx-2.5 focus-visible:ring-sidebar-ring/50" />
      <SidebarNav role={role} />
      <div className="mt-auto flex items-center justify-between px-1.5">
        <ModeToggle />
        <ProfileMenu user={user} side="top" align="end" />
      </div>
    </aside>
  )
}
