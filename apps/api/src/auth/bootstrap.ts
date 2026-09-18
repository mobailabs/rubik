import { count, createDB, eq, user } from "@repo/db"

/** 把 `a@x.com, b@y.com` 解析成小写集合。 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * 首个管理员的逃生舱。
 *
 * 只在「库里一个 admin 都没有」时生效 —— 这是一个真正的引导动作，不是持续覆盖：
 * 手动撤销某人的 admin 之后，白名单不会在下次登录时把它翻回来。库归零只可能发生在
 * 全新环境，或者有人直接改库；此时白名单里的邮箱一登录就恢复管理员，所以进得去。
 */
export async function bootstrapAdmin(
  env: Env,
  userId: string,
): Promise<boolean> {
  const emails = parseAdminEmails(env.BOOTSTRAP_ADMINS)
  if (emails.size === 0) return false

  const db = createDB(env.DATABASE_URL)

  const [existing] = await db
    .select({ n: count() })
    .from(user)
    .where(eq(user.role, "admin"))
  if ((existing?.n ?? 0) > 0) return false

  const [row] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(eq(user.id, userId))
  if (!row || row.role === "admin" || !emails.has(row.email.toLowerCase()))
    return false

  await db.update(user).set({ role: "admin" }).where(eq(user.id, row.id))
  return true
}
