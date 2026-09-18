import { Fragment, useEffect, useState } from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { ShieldCheckIcon } from "lucide-react"
import { useBanUser, useUnbanUser } from "@/hooks/mutations/use-ban-user"
import { useSetRole } from "@/hooks/mutations/use-set-role"
import {
  useAdminAudit,
  type AdminAuditEntry,
} from "@/hooks/queries/use-admin-audit"
import { useAdminUserDetail } from "@/hooks/queries/use-admin-user-detail"
import { useAdminUsers, type AdminUser } from "@/hooks/queries/use-admin-users"
import { HOME_PATH } from "@/lib/guards"
import { pageHead } from "@/lib/site"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { cn } from "@repo/ui/lib/utils"

export const Route = createFileRoute("/dashboard/admin/")({
  head: () =>
    pageHead({ title: "Admin", path: "/dashboard/admin", noIndex: true }),
  // 角色在上层路由（/dashboard）已经取过了，这里只做体验层的拦截。
  beforeLoad: ({ context }) => {
    if (context.role !== "admin") throw redirect({ to: HOME_PATH })
  },
  component: AdminPage,
})

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

function AdminPage() {
  const [q, setQ] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  const debouncedQ = useDebounced(q, 300)

  const { data, isLoading, error } = useAdminUsers(debouncedQ)
  const { data: audit } = useAdminAudit()
  const setRole = useSetRole()
  const ban = useBanUser()
  const unban = useUnbanUser()
  const { session } = Route.useRouteContext()
  const meId = session.user.id

  if (isLoading)
    return <p className="text-muted-foreground text-sm">加载中…</p>
  if (error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    )

  const adminCount = data?.adminCount ?? 0
  const items = data?.items ?? []

  // 同一行上三个写操作，任何一个在飞就把整行锁住，避免连点。
  const pendingId = setRole.isPending
    ? setRole.variables?.userId
    : ban.isPending
      ? ban.variables?.userId
      : unban.isPending
        ? unban.variables?.userId
        : null
  const mutationError = setRole.error ?? ban.error ?? unban.error

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
          <p className="text-muted-foreground text-sm">
            共 {data?.total ?? 0} 位用户
            {data && items.length === data.total
              ? ` · 其中 ${adminCount} 位管理员`
              : ""}
          </p>
        </div>
        <div className="w-full sm:w-64">
          <Input
            type="search"
            aria-label="按邮箱搜索用户"
            placeholder="按邮箱搜索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {mutationError && (
        <p role="alert" className="text-destructive text-sm">
          {mutationError.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                邮箱
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                名字
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                邮箱验证
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                注册时间
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                课程
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                状态
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                角色
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((u) => (
              <Fragment key={u.id}>
                <tr className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">
                    {u.email}
                    {u.id === meId && (
                      <span className="text-muted-foreground ml-1.5 text-xs">
                        （你）
                      </span>
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">{u.name}</td>
                  <td className="px-3 py-2">
                    {u.emailVerified ? (
                      "已验证"
                    ) : (
                      <span className="text-muted-foreground">未验证</span>
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {u.lessonCount}
                  </td>
                  <td className="px-3 py-2">
                    {u.banned ? (
                      <span className="bg-destructive/10 text-destructive inline-flex items-center rounded-full px-2 py-0.5 text-[11px]">
                        已封禁
                      </span>
                    ) : (
                      <span className="text-muted-foreground">正常</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="xs"
                        variant={openId === u.id ? "secondary" : "ghost"}
                        aria-expanded={openId === u.id}
                        onClick={() =>
                          setOpenId((prev) => (prev === u.id ? null : u.id))
                        }
                      >
                        {openId === u.id ? "收起" : "详情"}
                      </Button>
                      <RoleButton
                        user={u}
                        meId={meId}
                        adminCount={adminCount}
                        pending={pendingId === u.id}
                        disabled={pendingId !== null}
                        onSet={(role) => setRole.mutate({ userId: u.id, role })}
                      />
                      <BanButton
                        user={u}
                        meId={meId}
                        pending={pendingId === u.id}
                        disabled={pendingId !== null}
                        onBan={() => ban.mutate({ userId: u.id })}
                        onUnban={() => unban.mutate({ userId: u.id })}
                      />
                    </div>
                  </td>
                </tr>
                {openId === u.id && (
                  <tr className="bg-muted/20">
                    <td colSpan={8} className="px-3 py-3">
                      <UserDetail userId={u.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground text-xs">
        不能修改或封禁自己；至少要保留一个管理员；封禁管理员前要先撤销其管理员身份。
        封禁会同时清掉该用户的全部会话，解封后需要重新登录。
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">最近变更</h2>
        {!audit?.items.length ? (
          <p className="text-muted-foreground text-sm">还没有变更记录。</p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {audit.items.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span>{auditLine(entry)}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Who({ email }: { email: string | null }) {
  return <span className="font-medium">{email ?? "已注销用户"}</span>
}

function auditLine(entry: AdminAuditEntry) {
  const reason = entry.detail?.reason
  switch (entry.action) {
    case "role.grant":
      return (
        <>
          <Who email={entry.actor} /> 把 <Who email={entry.target} /> 设为管理员
        </>
      )
    case "role.revoke":
      return (
        <>
          <Who email={entry.actor} /> 撤销了 <Who email={entry.target} />{" "}
          的管理员
        </>
      )
    case "user.ban":
      return (
        <>
          <Who email={entry.actor} /> 封禁了 <Who email={entry.target} />
          {typeof reason === "string" && reason ? `（${reason}）` : ""}
        </>
      )
    case "user.unban":
      return (
        <>
          <Who email={entry.actor} /> 解封了 <Who email={entry.target} />
        </>
      )
    default:
      return (
        <>
          <Who email={entry.actor} /> 对 <Who email={entry.target} /> 执行了{" "}
          {entry.action}
        </>
      )
  }
}

function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === "admin"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
        isAdmin
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {isAdmin && <ShieldCheckIcon className="size-3" aria-hidden />}
      {isAdmin ? "管理员" : "普通用户"}
    </span>
  )
}

function RoleButton({
  user,
  meId,
  adminCount,
  pending,
  disabled,
  onSet,
}: {
  user: AdminUser
  meId: string
  adminCount: number
  pending: boolean
  disabled: boolean
  onSet: (role: "user" | "admin") => void
}) {
  const isAdmin = user.role === "admin"
  const reason =
    user.id === meId
      ? "不能修改自己的角色"
      : isAdmin && adminCount <= 1
        ? "至少要保留一个管理员"
        : undefined

  return (
    <Button
      size="xs"
      variant={isAdmin ? "outline" : "default"}
      disabled={disabled || pending || Boolean(reason)}
      title={reason}
      onClick={() => onSet(isAdmin ? "user" : "admin")}
    >
      {isAdmin ? "撤销管理员" : "设为管理员"}
    </Button>
  )
}

function BanButton({
  user,
  meId,
  pending,
  disabled,
  onBan,
  onUnban,
}: {
  user: AdminUser
  meId: string
  pending: boolean
  disabled: boolean
  onBan: () => void
  onUnban: () => void
}) {
  // 解封是恢复动作，不看目标角色，也不拦自己。
  if (user.banned)
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || pending}
        onClick={onUnban}
      >
        解封
      </Button>
    )

  const reason =
    user.id === meId
      ? "不能封禁自己"
      : user.role === "admin"
        ? "不能封禁管理员，请先撤销其管理员身份"
        : undefined

  return (
    <Button
      size="xs"
      variant="destructive"
      disabled={disabled || pending || Boolean(reason)}
      title={reason}
      onClick={onBan}
    >
      封禁
    </Button>
  )
}

function UserDetail({ userId }: { userId: string }) {
  const { data, isLoading, error } = useAdminUserDetail(userId)

  if (isLoading)
    return <p className="text-muted-foreground text-sm">加载详情…</p>
  if (error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    )
  if (!data) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>注册 {new Date(data.user.createdAt).toLocaleString()}</span>
        <span>课程 {data.lessonCount} 门</span>
        <span>练习 {data.attemptCount} 次</span>
        <span>会话 {data.sessions.length} 个</span>
        {data.user.banned && (
          <span className="text-destructive">
            已封禁 · {data.user.banReason ?? "未填原因"}
          </span>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <DetailList
          title="课程"
          empty="没有课程"
          rows={data.lessons.map((l) => ({
            key: l.id,
            main: l.title,
            sub: `${l.status} · ${l.sentenceCount} 句 / ${l.wordCount} 词`,
            right: new Date(l.createdAt).toLocaleDateString(),
          }))}
        />
        <DetailList
          title="练习记录"
          empty="没有记录"
          rows={data.attempts.map((a) => ({
            key: String(a.id),
            main: a.lessonId,
            sub: `正确率 ${a.accuracy ?? a.score}%`,
            right: new Date(a.createdAt).toLocaleDateString(),
          }))}
        />
        <DetailList
          title="会话"
          empty="没有会话"
          rows={data.sessions.map((s) => ({
            key: s.id,
            main: s.ipAddress ?? "未知 IP",
            sub: s.userAgent ?? "",
            right: `至 ${new Date(s.expiresAt).toLocaleDateString()}`,
          }))}
        />
      </div>
    </div>
  )
}

type DetailRow = { key: string; main: string; sub: string; right: string }

function DetailList({
  title,
  empty,
  rows,
}: {
  title: string
  empty: string
  rows: DetailRow[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-medium">
        {title}
        {rows.length ? ` · ${rows.length}` : ""}
      </h3>
      {!rows.length ? (
        <p className="text-muted-foreground text-xs">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className="bg-background flex items-start justify-between gap-2 rounded-lg border px-2 py-1.5 text-xs"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.main}</span>
                <span className="text-muted-foreground block truncate">
                  {r.sub}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0">{r.right}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
