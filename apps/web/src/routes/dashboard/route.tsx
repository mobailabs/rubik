import { createFileRoute, Outlet } from "@tanstack/react-router"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Topbar } from "@/components/dashboard/topbar"
import { requireSessionWithRole } from "@/lib/guards"
import { pageHead } from "@/lib/site"

export const Route = createFileRoute("/dashboard")({
  head: () =>
    pageHead({ title: "Dashboard", path: "/dashboard", noIndex: true }),
  beforeLoad: async () => await requireSessionWithRole(),
  component: DashboardLayout,
})

function DashboardLayout() {
  const { session, role } = Route.useRouteContext()

  return (
    <div className="bg-background min-h-svh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Sidebar user={session.user} role={role} className="hidden lg:flex" />
      <div className="flex min-w-0 flex-col">
        <Topbar user={session.user} role={role} className="lg:hidden" />
        <main className="flex-1 px-6 py-10 lg:px-12">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
