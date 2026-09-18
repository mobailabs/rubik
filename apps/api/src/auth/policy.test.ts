/* 政策层单测：纯函数，不需要数据库、不需要起服务。
   跑法（root 没有 tsx，用 packages/db 里的那个；esbuild 也行）：
     ./node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild \
       apps/api/src/auth/policy.test.ts --bundle --platform=node --format=esm \
       --outfile=/tmp/policy.mjs && node /tmp/policy.mjs */
import {
  FORBIDDEN_PLUGIN_ADMIN_PATHS,
  READ_ONLY_ADMIN_PATHS,
  allowSignUp,
  banAction,
  checkBan,
  checkRoleChange,
  isPluginAdminPathAllowed,
  isRole,
  isSignUpPath,
  normalizeRole,
  roleAction,
  type BanInput,
  type RoleChangeInput,
} from "./policy"

let pass = 0
const failures: string[] = []

function t(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    failures.push(`${name}：期望 ${e}，实际 ${a}`)
    console.log(`  FAIL ${name}：期望 ${e}，实际 ${a}`)
  }
}

function base(over: Partial<RoleChangeInput> = {}): RoleChangeInput {
  return {
    actorId: "admin-1",
    actorRole: "admin",
    targetId: "user-1",
    targetRole: "user",
    nextRole: "admin",
    adminCount: 2,
    ...over,
  }
}

const verdict = (over: Partial<RoleChangeInput> = {}) => {
  const v = checkRoleChange(base(over))
  return v.ok ? { ok: true, changed: v.changed } : { ok: false, code: v.code }
}

/** 两条规则都是 BAD_REQUEST，光看 code 分不出命中哪条 —— 断言提示语来钉住分支。 */
const failMessage = (over: Partial<RoleChangeInput> = {}) => {
  const v = checkRoleChange(base(over))
  return v.ok ? "（没有拒绝）" : v.message
}

console.log("isRole")
t("user 是合法角色", isRole("user"), true)
t("admin 是合法角色", isRole("admin"), true)
t("root 不是合法角色", isRole("root"), false)
t("undefined 不是合法角色", isRole(undefined), false)

console.log("roleAction")
t("升为 admin → role.grant", roleAction("admin"), "role.grant")
t("降为 user → role.revoke", roleAction("user"), "role.revoke")

console.log("normalizeRole")
t("admin → admin", normalizeRole("admin"), "admin")
t("user → user", normalizeRole("user"), "user")
t("null → user（插件把 role 声明成可选）", normalizeRole(null), "user")
t("undefined → user", normalizeRole(undefined), "user")
t("脏值 → user", normalizeRole("root"), "user")

console.log("checkRoleChange")
t("管理员把普通用户设为管理员", verdict(), { ok: true, changed: true })
t(
  "管理员撤销另一个管理员（还有 2 个）",
  verdict({ targetId: "admin-2", targetRole: "admin", nextRole: "user" }),
  { ok: true, changed: true },
)
t("非管理员操作 → 403", verdict({ actorRole: "user" }), { ok: false, code: "FORBIDDEN" })
t(
  "非管理员 + 非法角色 → 先报没权限",
  verdict({ actorRole: "user", nextRole: "root" }),
  { ok: false, code: "FORBIDDEN" },
)
t("非法角色值 → 400", verdict({ nextRole: "root" }), { ok: false, code: "BAD_REQUEST" })
t(
  "改自己的角色 → 400",
  verdict({ actorId: "admin-1", targetId: "admin-1", targetRole: "admin", nextRole: "user" }),
  { ok: false, code: "BAD_REQUEST" },
)
t(
  "降级最后一个管理员 → 400",
  verdict({ targetId: "admin-2", targetRole: "admin", nextRole: "user", adminCount: 1 }),
  { ok: false, code: "BAD_REQUEST" },
)
t(
  "降级最后一个管理员 → 提示保留一个（目标不是自己）",
  failMessage({ targetId: "admin-2", targetRole: "admin", nextRole: "user", adminCount: 1 }),
  "至少要保留一个管理员",
)
t(
  "改自己 → 提示让另一位管理员操作（不是撞到别的规则）",
  failMessage({ targetId: "admin-1", targetRole: "admin", nextRole: "user", adminCount: 2 }),
  "不能修改自己的角色，请让另一位管理员操作",
)
t(
  "把唯一管理员再设成 admin（幂等，不报错）",
  verdict({ actorId: "admin-1", targetId: "admin-1", targetRole: "admin", nextRole: "admin", adminCount: 1 }),
  { ok: true, changed: false },
)
t("普通用户已经是 user，再设一次 → 空操作", verdict({ nextRole: "user" }), {
  ok: true,
  changed: false,
})
t(
  "两个管理员时降级另一个（不触底）",
  verdict({ targetId: "admin-2", targetRole: "admin", nextRole: "user", adminCount: 2 }),
  { ok: true, changed: true },
)

function banBase(over: Partial<BanInput> = {}): BanInput {
  return {
    actorId: "admin-1",
    actorRole: "admin",
    targetId: "user-1",
    targetRole: "user",
    targetBanned: false,
    nextBanned: true,
    ...over,
  }
}

const banVerdict = (over: Partial<BanInput> = {}) => {
  const v = checkBan(banBase(over))
  return v.ok ? { ok: true, changed: v.changed } : { ok: false, code: v.code }
}

const banMessage = (over: Partial<BanInput> = {}) => {
  const v = checkBan(banBase(over))
  return v.ok ? "（没有拒绝）" : v.message
}

console.log("banAction")
t("封禁 → user.ban", banAction(true), "user.ban")
t("解封 → user.unban", banAction(false), "user.unban")

console.log("checkBan")
t("管理员封普通用户", banVerdict(), { ok: true, changed: true })
t("管理员解封已封禁用户", banVerdict({ targetBanned: true, nextBanned: false }), {
  ok: true,
  changed: true,
})
t("非管理员封人 → 403", banVerdict({ actorRole: "user" }), {
  ok: false,
  code: "FORBIDDEN",
})
t(
  "非管理员 + 封自己 → 先报没权限",
  banVerdict({ actorRole: "user", actorId: "admin-1", targetId: "admin-1" }),
  { ok: false, code: "FORBIDDEN" },
)
t(
  "封自己 → 400",
  banVerdict({ actorId: "admin-1", targetId: "admin-1", targetRole: "admin" }),
  { ok: false, code: "BAD_REQUEST" },
)
t("封自己 → 提示不能封自己", banMessage({ actorId: "admin-1", targetId: "admin-1" }), "不能封禁自己")
t(
  "封另一个管理员 → 400",
  banVerdict({ targetId: "admin-2", targetRole: "admin" }),
  { ok: false, code: "BAD_REQUEST" },
)
t(
  "封另一个管理员 → 提示先降权（不是撞到别的规则）",
  banMessage({ targetId: "admin-2", targetRole: "admin" }),
  "不能封禁管理员，请先撤销其管理员身份",
)
t("已经封了再封一次 → 空操作", banVerdict({ targetBanned: true }), {
  ok: true,
  changed: false,
})
t("没封过却要解封 → 空操作", banVerdict({ targetBanned: false, nextBanned: false }), {
  ok: true,
  changed: false,
})
t(
  "自己被封着、再解自己（幂等优先，不报不能封自己）",
  banVerdict({ actorId: "admin-1", targetId: "admin-1", targetBanned: true, nextBanned: true }),
  { ok: true, changed: false },
)
t(
  "解封一个被封的管理员 → 允许（恢复动作不设门槛）",
  banVerdict({ targetId: "admin-2", targetRole: "admin", targetBanned: true, nextBanned: false }),
  { ok: true, changed: true },
)

console.log("isPluginAdminPathAllowed")
// 放行的四个：无副作用的读/查询端点（list-user-sessions 与 has-permission 虽然是 POST，但不改数据）。
t("只读：list-users 放行", isPluginAdminPathAllowed("/admin/list-users"), true)
t("只读：get-user 放行", isPluginAdminPathAllowed("/admin/get-user"), true)
t("只读：list-user-sessions（POST 但只读）放行", isPluginAdminPathAllowed("/admin/list-user-sessions"), true)
t("只读：has-permission（纯判断）放行", isPluginAdminPathAllowed("/admin/has-permission"), true)

// 其余一律拒绝：这些都是会改库的端点，走它们就没有审计。
for (const p of [
  "/admin/set-role",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
])
  t(`写端点 ${p} 拒绝`, isPluginAdminPathAllowed(p), false)

/*
  上面那串是手抄的，抄漏一个就静默放行。这里改成从 FORBIDDEN_PLUGIN_ADMIN_PATHS 读，
  于是这张表本身也进了断言：有人把 /admin/ban-user 挪进 READ_ONLY_ADMIN_PATHS
  （比如"顺手补一个"），两条断言会同时红，而不是安静地开一条不留痕的写路径。
*/
for (const p of FORBIDDEN_PLUGIN_ADMIN_PATHS)
  t(`写端点 ${p} 拒绝（表驱动）`, isPluginAdminPathAllowed(p), false)

// 两个列表不许有交集：同一个路径既"只读"又"禁止"说明有人改错了地方。
const overlap = READ_ONLY_ADMIN_PATHS.filter((p) =>
  (FORBIDDEN_PLUGIN_ADMIN_PATHS as readonly string[]).includes(p),
)
t("只读名单与禁止名单无交集", overlap, [])

t("升级带进来的新端点也默认拒绝（不是列黑名单）", isPluginAdminPathAllowed("/admin/brand-new-thing"), false)
t("裸 /admin 也拒绝", isPluginAdminPathAllowed("/admin"), false)
t("前缀相近但不是 admin 族 → 放行", isPluginAdminPathAllowed("/admins/x"), true)

// 普通认证路径一概不受影响（否则登录/注册会被自己的护栏打死）。
for (const p of [
  "/sign-in/email",
  "/sign-up/email",
  "/sign-out",
  "/get-session",
  "/verify-email",
  "/reset-password",
  "/callback/github",
])
  t(`普通路径 ${p} 放行`, isPluginAdminPathAllowed(p), true)

// ── 注册开关 ──────────────────────────────────────────────
// 默认必须是关的：站点公网可达，开放注册等于把 S3 / whisper 送人。
t("ALLOW_SIGNUP 缺省 → 关闭", allowSignUp({}), false)
t("ALLOW_SIGNUP=false → 关闭", allowSignUp({ ALLOW_SIGNUP: "false" }), false)
t("ALLOW_SIGNUP=true → 开启", allowSignUp({ ALLOW_SIGNUP: "true" }), true)
// CF vars 只有字符串，别被真值骗了
t("ALLOW_SIGNUP=1 → 仍关闭", allowSignUp({ ALLOW_SIGNUP: "1" }), false)

t("注册路径 /sign-up/email 命中", isSignUpPath("/sign-up/email"), true)
t("注册路径 /sign-up 命中", isSignUpPath("/sign-up"), true)
t("登录路径不误伤", isSignUpPath("/sign-in/email"), false)
t("重置密码不误伤", isSignUpPath("/reset-password"), false)

console.log(`\n共 ${pass} 通过 / ${failures.length} 失败`)
if (failures.length) throw new Error(`政策层单测失败 ${failures.length} 条`)
