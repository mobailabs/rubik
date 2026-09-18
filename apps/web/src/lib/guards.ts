import { redirect } from "@tanstack/react-router"
import { authClient } from "./auth"
import { trpcClient } from "./trpc"

type SessionData = NonNullable<
  Awaited<ReturnType<typeof authClient.getSession>>["data"]
>

/**
 * 登录后 / 访问 `/` / 无名守卫把人送回的落点。
 *
 * 首页是统计页而不是 Tasks：打开应用第一眼该看到"我练到哪了、还差什么"，
 * 而不是一个待办清单。Tasks 没删、路径也没变（`/dashboard`），只是不再是默认落点。
 *
 * 集中成一个常量是因为有 5 处重定向指向它（登录成功、已登录访问登录页、
 * 非 admin 闯管理页、admin 页的 beforeLoad、根路径 `/`）—— 散在各处写死的话，
 * 下次想换首页得全找一遍，漏一处就出现"有的地方进统计、有的地方进 Tasks"。
 */
export const HOME_PATH = "/dashboard/stats" as const

/** 会话 + 角色，一起取。角色从服务端读（admin.me），不看会话里缓存的那份。 */
export type GuardValue = {
  session: SessionData
  role: string
}

/**
 * 守卫结果缓存（会话 + 角色）。
 *
 * 为什么必须缓存：`/dashboard` 的 `beforeLoad` 会在**每一次子路由切换**时重跑，
 * 而 `get-session` 和 `admin.me` 各要一次跨洋 DB 往返（本机实测每个 0.8~1.6s）。
 * 不缓存的话，每点一次侧边栏都要先白等一两秒，而且等的时候整块外壳
 * （含侧边栏）都出不来 —— 感觉就是"页面卡住了"。
 *
 * 策略：stale-while-revalidate。有缓存就**立刻返回**（切页零等待），
 * 同时在后台刷新（每 `REFRESH_MS` 最多一次），角色被改 / 被撤权随后自动收敛。
 * 只有首次进 dashboard（无缓存）才需要等那一次请求；并发导航共享同一个请求。
 *
 * 正确性没有让步：真正的边界在服务端 —— `adminProcedure` 每次调用都查库，
 * 前端这道只管"入口显不显示、页面渲不渲染"。所以刷新间隔只影响
 * "被撤权的人入口晚多久消失"。
 */
const REFRESH_MS = 10_000
let cache: { at: number; value: GuardValue } | null = null
let inflight: Promise<GuardValue> | null = null

function loadGuard(): Promise<GuardValue> {
  if (inflight) return inflight

  inflight = (async () => {
    const { data: session } = await authClient.getSession()
    if (!session) throw redirect({ to: "/sign-in" })
    const { role } = await trpcClient.admin.me.query()
    return { session, role }
  })().finally(() => {
    inflight = null
  })

  return inflight
}

/** 登录 / 登出 / 切换身份后必须调，否则会拿旧身份继续用。 */
export function forgetGuardCache() {
  cache = null
}

export async function requireSessionWithRole(): Promise<GuardValue> {
  if (cache) {
    if (Date.now() - cache.at > REFRESH_MS) {
      // 后台刷新：不 await，切页不受影响。丢掉缓存是为了让下次导航
      // 老老实实走一遍 —— 会话真失效时那次会正常 redirect 到登录页。
      void loadGuard()
        .then((value) => {
          cache = { at: Date.now(), value }
        })
        .catch(() => {
          cache = null
        })
    }
    return cache.value
  }

  const value = await loadGuard()
  cache = { at: Date.now(), value }
  return value
}

export async function requireSession() {
  const { session } = await requireSessionWithRole()
  return session
}

export async function requireNoSession() {
  const { data: session } = await authClient.getSession()
  if (session) throw redirect({ to: HOME_PATH })
}

/** 前端这道守卫只负责体验（不显示入口、不渲染页面），真正的边界在服务端。 */
export async function requireAdmin() {
  const ctx = await requireSessionWithRole()
  if (ctx.role !== "admin") throw redirect({ to: HOME_PATH })
  return ctx
}
