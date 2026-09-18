import { TRPCError } from "@trpc/server"
import {
  adminAudit,
  alias,
  attempts,
  count,
  desc,
  eq,
  ilike,
  lessons,
  or,
  session,
  sql,
  user,
} from "@repo/db"
import { z } from "zod"
import {
  banAction,
  checkBan,
  checkRoleChange,
  normalizeRole,
  roleAction,
} from "../../auth/policy"
import { adminProcedure, protectedProcedure, router } from "../init"
import type { AuthUser, Context } from "../init"

const roleEnum = z.enum(["user", "admin"])

/** adminProcedure 之后 user 一定存在，helper 里显式标出来省掉一堆断言。 */
type AdminCtx = Context & { user: AuthUser }

/**
 * 封禁 / 解封的共同处理：policy 判定 → 一次 batch 里改三列 + 清会话 + 写审计。
 *
 * 清会话这步不能省：better-auth 只在「建会话」时检查 banned
 * （插件 databaseHooks.session.create.before），已登录的会话不会自己失效。
 */
async function setBanned(
  ctx: AdminCtx,
  input: { userId: string; reason?: string },
  nextBanned: boolean,
) {
  const [target] = await ctx.db
    .select({ id: user.id, role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, input.userId))
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" })

  const verdict = checkBan({
    actorId: ctx.user.id,
    actorRole: normalizeRole(ctx.user.role),
    targetId: target.id,
    targetRole: normalizeRole(target.role),
    targetBanned: target.banned,
    nextBanned,
  })
  if (!verdict.ok)
    throw new TRPCError({ code: verdict.code, message: verdict.message })
  if (!verdict.changed) return { changed: false, banned: nextBanned }

  const reason = input.reason?.trim() || "管理员操作"
  const updateRow = ctx.db
    .update(user)
    .set(
      nextBanned
        ? { banned: true, banReason: reason, banExpires: null }
        : { banned: false, banReason: null, banExpires: null },
    )
    .where(eq(user.id, target.id))
  const auditRow = ctx.db.insert(adminAudit).values({
    id: crypto.randomUUID(),
    actorId: ctx.user.id,
    targetId: target.id,
    action: banAction(nextBanned),
    detail: nextBanned ? { reason } : {},
  })

  if (nextBanned)
    await ctx.db.batch([
      updateRow,
      ctx.db.delete(session).where(eq(session.userId, target.id)),
      auditRow,
    ])
  else await ctx.db.batch([updateRow, auditRow])

  return { changed: true, banned: nextBanned }
}

export const adminRouter = router({
  /** 客户端读 role 的唯一来源（不信任会话里缓存的那份）。 */
  me: protectedProcedure.query(({ ctx }) => ({
    role: normalizeRole(ctx.user.role),
  })),

  users: adminProcedure
    .input(
      z.object({
        q: z.string().trim().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filter = input.q
        ? or(ilike(user.email, `%${input.q}%`), ilike(user.name, `%${input.q}%`))
        : undefined

      // 库在新加坡、本机每个查询要一个跨洋往返（0.5~1s），所以这里全部并发，
      // 课程数用相关子查询折进主查询（省掉「先拿 id 再查一次课程数」的第二个往返）。
      // 之前串行四个查询，admin 页要 4.3s；现在一个往返。
      const [rows, totalRows, adminRows] = await Promise.all([
        ctx.db
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            role: user.role,
            banned: user.banned,
            createdAt: user.createdAt,
            // ⚠️ 这里必须手写全限定名：drizzle 在 sql 片段里把列渲染成
            // 不带表名的 `"owner_id"`，子查询里就会两边都落在 lessons 上
            // （`where "owner_id" = "id"`），结果恒为 0。
            lessonCount:
              sql<number>`(select count(*)::int from "lessons" l where l."owner_id" = "user"."id")`,
          })
          .from(user)
          .where(filter)
          .orderBy(desc(user.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db.select({ n: count() }).from(user).where(filter),
        // 全库管理员数：界面用它禁用「撤销最后一个管理员」的按钮
        ctx.db.select({ n: count() }).from(user).where(eq(user.role, "admin")),
      ])

      return {
        total: totalRows[0]?.n ?? 0,
        adminCount: adminRows[0]?.n ?? 0,
        items: rows.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          emailVerified: u.emailVerified,
          role: normalizeRole(u.role),
          banned: u.banned,
          createdAt: u.createdAt,
          lessonCount: u.lessonCount,
        })),
      }
    }),

  /**
   * 授权 / 撤权。护栏来自 policy；改 role 与写审计放进同一次 batch
   * （neon-http 的 batch 就是一次事务），所以不会出现「改了但没记上」。
   */
  setRole: adminProcedure
    .input(z.object({ userId: z.string().min(1), role: roleEnum }))
    .mutation(async ({ ctx, input }) => {
      const [target] = await ctx.db
        .select({ id: user.id, role: user.role })
        .from(user)
        .where(eq(user.id, input.userId))
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" })

      const [admins] = await ctx.db
        .select({ n: count() })
        .from(user)
        .where(eq(user.role, "admin"))

      const targetRole = normalizeRole(target.role)
      const verdict = checkRoleChange({
        actorId: ctx.user.id,
        actorRole: normalizeRole(ctx.user.role),
        targetId: target.id,
        targetRole,
        nextRole: input.role,
        adminCount: admins?.n ?? 0,
      })
      if (!verdict.ok)
        throw new TRPCError({ code: verdict.code, message: verdict.message })
      if (!verdict.changed) return { changed: false, role: targetRole }

      await ctx.db.batch([
        ctx.db
          .update(user)
          .set({ role: input.role })
          .where(eq(user.id, target.id)),
        ctx.db.insert(adminAudit).values({
          id: crypto.randomUUID(),
          actorId: ctx.user.id,
          targetId: target.id,
          action: roleAction(input.role),
          detail: { from: targetRole, to: input.role },
        }),
      ])

      return { changed: true, role: input.role }
    }),

  banUser: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setBanned(ctx, input, true)),

  unbanUser: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(({ ctx, input }) => setBanned(ctx, input, false)),

  /** 单个用户的底细：课程 / 练习记录 / 会话。排查「他看到的到底是什么」用这个。 */
  userDetail: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      // 五个查询都只用 input.userId，所以并发发出去（别先 await 用户行再查其余四个，
      // 那会多一个跨洋往返）。用户不存在时下面再判。
      const [userRows, lessonRows, attemptRows, sessionRows, attemptTotals] =
        await Promise.all([
          ctx.db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              emailVerified: user.emailVerified,
              role: user.role,
              banned: user.banned,
              banReason: user.banReason,
              banExpires: user.banExpires,
              createdAt: user.createdAt,
            })
            .from(user)
            .where(eq(user.id, input.userId)),
          ctx.db
            .select({
              id: lessons.id,
              title: lessons.title,
              status: lessons.status,
              sentenceCount: lessons.sentenceCount,
              wordCount: lessons.wordCount,
              createdAt: lessons.createdAt,
            })
            .from(lessons)
            .where(eq(lessons.ownerId, input.userId))
            .orderBy(desc(lessons.createdAt))
            .limit(50),
          ctx.db
            .select({
              id: attempts.id,
              lessonId: attempts.lessonId,
              score: attempts.score,
              accuracy: attempts.accuracy,
              wpm: attempts.wpm,
              createdAt: attempts.createdAt,
            })
            .from(attempts)
            .where(eq(attempts.userId, input.userId))
            .orderBy(desc(attempts.createdAt))
            .limit(50),
          ctx.db
            .select({
              id: session.id,
              createdAt: session.createdAt,
              expiresAt: session.expiresAt,
              ipAddress: session.ipAddress,
              userAgent: session.userAgent,
            })
            .from(session)
            .where(eq(session.userId, input.userId))
            .orderBy(desc(session.createdAt))
            .limit(20),
          ctx.db
            .select({ n: count() })
            .from(attempts)
            .where(eq(attempts.userId, input.userId)),
        ])

      const [u] = userRows
      if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" })

      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          emailVerified: u.emailVerified,
          role: normalizeRole(u.role),
          banned: u.banned,
          banReason: u.banReason,
          banExpires: u.banExpires,
          createdAt: u.createdAt,
        },
        lessons: lessonRows,
        attempts: attemptRows,
        sessions: sessionRows,
        lessonCount: lessonRows.length,
        attemptCount: attemptTotals[0]?.n ?? 0,
      }
    }),

  /** 最近的变更流水。 */
  audit: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      // 两次 left join 把 actor / target 的邮箱一起取回来：一次往返。
      // （原来是先查流水、再按 id 查邮箱，两个跨洋往返。）
      const actor = alias(user, "actor")
      const target = alias(user, "target")

      const rows = await ctx.db
        .select({
          id: adminAudit.id,
          action: adminAudit.action,
          detail: adminAudit.detail,
          createdAt: adminAudit.createdAt,
          actor: actor.email,
          target: target.email,
        })
        .from(adminAudit)
        .leftJoin(actor, eq(adminAudit.actorId, actor.id))
        .leftJoin(target, eq(adminAudit.targetId, target.id))
        .orderBy(desc(adminAudit.createdAt))
        .limit(input.limit)

      return {
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          // 不同 action 的 detail 形状不同（role 是 from/to，ban 是 reason）
          detail: r.detail as Record<string, unknown>,
          createdAt: r.createdAt,
          // 用户被删后审计行仍在（on delete set null），这时 actor/target 是 null
          actor: r.actor ?? null,
          target: r.target ?? null,
        })),
      }
    }),
})
