/**
 * 角色变更的政策层：纯函数，不碰数据库、不碰框架。
 *
 * 唯一的调用方是 tRPC（admin.setRole / admin.banUser / admin.unbanUser）。
 * 插件自己的 `/admin/*` 端点已由 auth/index.ts 的 hooks.before 整体关掉，
 * 所以这里不需要再为「有人绕过路由直连插件端点」做兜底 —— 那条路根本不放行。
 *
 * 判定写成纯函数是为了能脱离框架单测：见 policy.test.ts。
 */

export const ROLES = ["user", "admin"] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return value === "user" || value === "admin"
}

/** 插件把 role 声明成可选的 string，落库/返回前统一收窄。 */
export function normalizeRole(value: unknown): Role {
  return value === "admin" ? "admin" : "user"
}

/** 审计流水里的动作名。 */
export function roleAction(next: Role) {
  return next === "admin" ? "role.grant" : "role.revoke"
}

export function banAction(banned: boolean) {
  return banned ? "user.ban" : "user.unban"
}

export type RoleChangeInput = {
  actorId: string
  actorRole: Role
  targetId: string
  targetRole: Role
  /** 来自请求体，所以是 string，需要自己收窄。 */
  nextRole: string
  /** 当前库里 admin 的总数，用于「不能撤掉最后一个 admin」。 */
  adminCount: number
}

export type RoleChangeVerdict =
  | { ok: true; changed: boolean }
  | { ok: false; code: "FORBIDDEN" | "BAD_REQUEST"; message: string }

export function checkRoleChange(c: RoleChangeInput): RoleChangeVerdict {
  if (c.actorRole !== "admin")
    return { ok: false, code: "FORBIDDEN", message: "只有管理员能修改角色" }

  if (!isRole(c.nextRole))
    return { ok: false, code: "BAD_REQUEST", message: "角色只能是 user 或 admin" }

  // 幂等放在「不能改自己」之前：自己把自己设成当前角色是空操作，不该报错。
  if (c.nextRole === c.targetRole) return { ok: true, changed: false }

  if (c.actorId === c.targetId)
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "不能修改自己的角色，请让另一位管理员操作",
    }

  if (c.nextRole === "user" && c.targetRole === "admin" && c.adminCount <= 1)
    return { ok: false, code: "BAD_REQUEST", message: "至少要保留一个管理员" }

  return { ok: true, changed: true }
}

export type BanInput = {
  actorId: string
  actorRole: Role
  targetId: string
  targetRole: Role
  /** 目标当前是否已封禁，用于幂等。 */
  targetBanned: boolean
  /** 这次要封还是要解。 */
  nextBanned: boolean
}

export type BanVerdict =
  | { ok: true; changed: boolean }
  | { ok: false; code: "FORBIDDEN" | "BAD_REQUEST"; message: string }

export function checkBan(c: BanInput): BanVerdict {
  if (c.actorRole !== "admin")
    return { ok: false, code: "FORBIDDEN", message: "只有管理员能封禁用户" }

  // 幂等先判：已经封了再封一次、没封再解一次，都是空操作。
  if (c.nextBanned === c.targetBanned) return { ok: true, changed: false }

  // 解封是恢复动作，只看权限，不再加门槛。
  if (c.nextBanned) {
    if (c.actorId === c.targetId)
      return { ok: false, code: "BAD_REQUEST", message: "不能封禁自己" }

    if (c.targetRole === "admin")
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "不能封禁管理员，请先撤销其管理员身份",
      }
  }

  return { ok: true, changed: true }
}

/**
 * 注册开关（自用单用户，默认关）。
 *
 * CF 的 vars 只能是字符串，所以只有严格等于 "true" 才算开。
 * 要临时开一个账号：wrangler.jsonc 里设 ALLOW_SIGNUP="true" 再 deploy，用完改回来。
 */
export function allowSignUp(env: { ALLOW_SIGNUP?: string }): boolean {
  return env.ALLOW_SIGNUP === "true"
}

/**
 * 注册路径。只挡邮箱注册那一族。
 *
 * ⚠️ 第三方登录（/sign-in/social）在 better-auth 里是"没有账号就顺带建一个"，
 * 不经过 /sign-up —— 以后真接了 OAuth 得另外处理，别以为这里关了就全关了。
 * 目前 OAuth 四项都是空的，走不到那条路。
 */
export function isSignUpPath(path: string): boolean {
  return path === "/sign-up" || path.startsWith("/sign-up/")
}

/**
 * 插件 `/admin/*` 端点的收口规则。
 *
 * 这套端点是公开可打的 HTTP 接口，而我们的审计只在 tRPC 侧写 —— 谁直连它们改库，
 * 库里就不留痕。所以只放行无副作用的几个，其余（含以后升级带进来的新端点）默认拒绝。
 *
 * ⚠️ 这个数组**只能放只读端点**。插件里还带着 `/admin/ban-user`、`/admin/set-role`
 * 这类写端点，它们名字看着像管理动作，但走的是插件自己的实现：不写 admin_audit、
 * 也绕开 policy 的「不能封自己 / 不能撤掉最后一个 admin」那几条。谁把它们加进来，
 * 就等于开了一条不留痕的写路径，而 auth/index.ts 的注释把「插件端点不留痕」明确
 * 列为要防的事。这条约束由 policy.test.ts 钉住（断言这些路径被拒绝），别只靠注释。
 *
 * 以后要用某个插件端点，正确做法是在 tRPC 里包一层由 tRPC 写审计，再把它加进来。
 */
export const READ_ONLY_ADMIN_PATHS = [
  "/admin/get-user",
  "/admin/list-users",
  "/admin/list-user-sessions",
  "/admin/has-permission",
] as const

/**
 * 明确不许直接放行的写端点。
 *
 * 单独列出来是为了让上面那条约束在测试里可断言：这些路径在任何情况下都必须
 * 走 tRPC 那套（判权 + 写审计），直连一律拒绝。
 */
export const FORBIDDEN_PLUGIN_ADMIN_PATHS = [
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/set-role",
  "/admin/create-user",
  "/admin/remove-user",
  "/admin/update-user",
  "/admin/set-user-password",
  "/admin/revoke-user-sessions",
  "/admin/revoke-user-session",
] as const

/** 只有 /admin 这一族归本规则管；其它路径（登录、注册、验证…）一律放行。 */
export function isPluginAdminPathAllowed(path: string): boolean {
  if (path !== "/admin" && !path.startsWith("/admin/")) return true
  return (READ_ONLY_ADMIN_PATHS as readonly string[]).includes(path)
}
