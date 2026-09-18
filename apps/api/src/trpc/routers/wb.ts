import { TRPCError } from "@trpc/server"
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lessons,
  lte,
  sql,
  wrongWords,
} from "@repo/db"
import { z } from "zod"
import { protectedProcedure, router } from "../init"

/**
 * 极简调度（不是 SRS，不做 FSRS 那套稳定性/难度建模 —— 自用场景收益撑不起复杂度）。
 *
 * `good` 是连续答对次数，间隔按 2 / 4 / 8 / 16 / 30 天推进，good 满 5 自动毕业；
 * 答错归零、明天再来。整个"记忆系统"就这十几行。
 */
const STEP_DAYS = [0, 2, 4, 8, 16, 30]
const GRADUATE_GOOD = 5
const DAY_MS = 86_400_000

function nextDue(good: number): Date {
  const days = STEP_DAYS[Math.min(good, STEP_DAYS.length - 1)]
  return new Date(Date.now() + days * DAY_MS)
}

/**
 * 错词本（wb = wrong book）。
 *
 * 数据模型见 packages/db/src/wrong-words.ts。所有接口走 `protectedProcedure`，
 * user_id 永远从 `ctx.user.id` 拿、读永远带 `eq(userId, ...)`，挡掉越权读写。
 *
 * 删除传播：FK 是 onDelete cascade，所以删课时会自动清该课的错词、注销用户时
 * 一并清本人所有错词 —— 接口层不需要再写删除传播逻辑。
 */
const recordInput = z.object({
  lessonId: z.string().min(1),
  wordNorm: z.string().min(1).max(64),
  display: z.string().min(1).max(64),
  audioUrl: z.string().url(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /**
   * 用户主动加入时为 true：把已标「会了」的行拉回活跃。
   * 否则会出现「我手动加了，但它在已会那档里看不见」的假失败。
   */
  unmaster: z.boolean().default(false),
})

/** 生成错词行的 PK。当前用 `crypto.randomUUID()` 即可（前端/后端都能生成）。 */
function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : // 退化路径：hex 时间戳 + 随机尾巴，避免重复
      "ww_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

export const wbRouter = router({
  /**
   * 列表。带 `lessonId`（join 出课程标题，按课分组；前端少一次往返）。
   *
   * scope：`due`（默认，未会且已到期）/ `active`（未会，不管到没到期）/
   * `all` / `mastered`。默认只给到期的 —— 打开错词本就该只看到今天该练的。
   *
   * 排序：mastered 的按 last_seen_at desc 排到末尾以示区别，
   * 未 master 的按同样规则（最近错的在前）。
   */
  list: protectedProcedure
    .input(
      z
        .object({
          scope: z.enum(["due", "active", "all", "mastered"]).default("due"),
        })
        .default({ scope: "due" }),
    )
    .query(async ({ ctx, input }) => {
      const uid = eq(wrongWords.userId, ctx.user.id)
      const conditions =
        input.scope === "all"
          ? uid
          : input.scope === "mastered"
            ? and(uid, eq(wrongWords.mastered, true))
            : input.scope === "active"
              ? and(uid, eq(wrongWords.mastered, false))
              : and(uid, eq(wrongWords.mastered, false), lte(wrongWords.dueAt, new Date()))

      // 一次往返内联拿课程标题，省掉前端再调 lessons.list
      const rows = await ctx.db
        .select({
          id: wrongWords.id,
          lessonId: wrongWords.lessonId,
          lessonTitle: lessons.title,
          wordNorm: wrongWords.wordNorm,
          display: wrongWords.display,
          audioUrl: wrongWords.audioUrl,
          startMs: wrongWords.startMs,
          endMs: wrongWords.endMs,
          n: wrongWords.n,
          mastered: wrongWords.mastered,
          good: wrongWords.good,
          dueAt: wrongWords.dueAt,
          firstSeenAt: wrongWords.firstSeenAt,
          lastSeenAt: wrongWords.lastSeenAt,
        })
        .from(wrongWords)
        .leftJoin(lessons, eq(wrongWords.lessonId, lessons.id))
        .where(conditions)
        .orderBy(
          desc(wrongWords.mastered),
          desc(wrongWords.lastSeenAt),
          asc(wrongWords.display),
        )

      return rows.map((r) => ({
        ...r,
        // join 命中失败（课已被删）时会 null，但 FK cascade 已经让 wrong_words
        // 被清掉了，正常路径下读不到 null。真出现说明 cascade 没生效，置个占位
        // 给 UI 兜底显示：
        lessonTitle: r.lessonTitle ?? "(已删除的课)",
      }))
    }),

  /**
   * 顶部统计：今日新增 / 总数 / 已会。仅活跃用户的视角。
   * 用一条 query 算三个数（FILTER），省两次往返。
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        mastered: sql<number>`count(*) FILTER (WHERE ${wrongWords.mastered})::int`,
        due: sql<number>`count(*) FILTER (WHERE NOT ${wrongWords.mastered} AND ${wrongWords.dueAt} <= now())::int`,
        today: sql<number>`count(*) FILTER (WHERE ${wrongWords.lastSeenAt} >= current_date)::int`,
      })
      .from(wrongWords)
      .where(eq(wrongWords.userId, ctx.user.id))
    return {
      total: rows[0]?.total ?? 0,
      mastered: rows[0]?.mastered ?? 0,
      due: rows[0]?.due ?? 0,
      today: rows[0]?.today ?? 0,
    }
  }),

  /**
   * 记录一次错词。INSERT ... ON CONFLICT DO UPDATE（drizzle 的 .onConflictDoUpdate）：
   * 命中唯一索引 (user_id, lesson_id, word_norm) 就 n++、刷新 last_seen_at、
   * 不再传 display / audioUrl / start/end —— 同一词第一次记下来就锁死入口，
   * 后端再错也只累计次数；显示样式由 UI 按当前 display 走。
   *
   * 课时必须存在且属于本人 —— 加 lessonId 校验（越权写容易排查）。
   */
  record: protectedProcedure
    .input(recordInput)
    .mutation(async ({ ctx, input }) => {
      const [lesson] = await ctx.db
        .select({ id: lessons.id, ownerId: lessons.ownerId })
        .from(lessons)
        .where(eq(lessons.id, input.lessonId))
      if (!lesson || lesson.ownerId !== ctx.user.id)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "课程不存在或无权限",
        })

      const [row] = await ctx.db
        .insert(wrongWords)
        .values({
          id: newId(),
          userId: ctx.user.id,
          lessonId: input.lessonId,
          wordNorm: input.wordNorm,
          display: input.display,
          audioUrl: input.audioUrl,
          startMs: input.startMs,
          endMs: input.endMs,
        })
        .onConflictDoUpdate({
          target: [wrongWords.userId, wrongWords.lessonId, wrongWords.wordNorm],
          set: {
            // display/audio/start/end 按第一次记录锁死：词原型别被「我又写成
            // 'the' 了」盖掉原来 'The' 的展示；同一词的入口语义不变。
            n: sql`${wrongWords.n} + 1`,
            lastSeenAt: sql`now()`,
            // 又写错一次 = lapse：连续答对清零、立刻回到到期队列。
            good: 0,
            dueAt: sql`now()`,
            // 手动加入（unmaster）才重置；自动记错不动 mastered —— 练习中
            // 再次写错是正常波动，不该悄悄推翻用户「我记住了」的判断。
            ...(input.unmaster ? { mastered: false } : {}),
          },
        })
        .returning()
      return row
    }),

  /**
   * 标记会了 / 取消会了。只能改本人行（userId WHERE 过滤）。
   *
   * 取消「会了」时顺便把调度清零 + 立刻到期 —— 否则 due_at 还停在未来，
   * 列表里看着"待复习"却永远刷不出来（假 bug）。
   */
  mark: protectedProcedure
    .input(z.object({ id: z.string().min(1), mastered: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(wrongWords)
        .set(
          input.mastered
            ? { mastered: true }
            : { mastered: false, good: 0, dueAt: new Date() },
        )
        .where(
          and(eq(wrongWords.id, input.id), eq(wrongWords.userId, ctx.user.id)),
        )
        .returning({ id: wrongWords.id, mastered: wrongWords.mastered })
      if (!row) throw new TRPCError({ code: "NOT_FOUND" })
      return row
    }),

  /**
   * 复习结果打点 —— 错词本 Drill 里每答一个词调一次。
   *
   * 答对：good++，due_at 往后推；good 满 5（间隔 30 天）自动毕业。
   * 答错：good 归零、明天再来，并把 mastered 打回 false（答错了就不算会）。
   *
   * 比原来的「答对一次就永久 master」严一点：一次蒙对不该让它彻底消失。
   */
  grade: protectedProcedure
    .input(z.object({ id: z.string().min(1), ok: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [cur] = await ctx.db
        .select({ good: wrongWords.good })
        .from(wrongWords)
        .where(
          and(eq(wrongWords.id, input.id), eq(wrongWords.userId, ctx.user.id)),
        )
      if (!cur) throw new TRPCError({ code: "NOT_FOUND" })

      const good = input.ok ? cur.good + 1 : 0
      const [row] = await ctx.db
        .update(wrongWords)
        .set({
          good,
          dueAt: input.ok ? nextDue(good) : new Date(Date.now() + DAY_MS),
          mastered: input.ok ? good >= GRADUATE_GOOD : false,
          lastSeenAt: new Date(),
        })
        .where(
          and(eq(wrongWords.id, input.id), eq(wrongWords.userId, ctx.user.id)),
        )
        .returning({
          id: wrongWords.id,
          good: wrongWords.good,
          mastered: wrongWords.mastered,
          dueAt: wrongWords.dueAt,
        })
      return row
    }),

  /**
   * 单条删除。仅允许本人行；批量删除走 mark + filter。
   */
  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db
        .delete(wrongWords)
        .where(
          and(eq(wrongWords.id, input.id), eq(wrongWords.userId, ctx.user.id)),
        )
        .returning({ id: wrongWords.id })
      if (deleted.length === 0)
        throw new TRPCError({ code: "NOT_FOUND" })
      return { id: input.id }
    }),

  /**
   * 批量按 lessonId 清掉（仅本人行）。删课时不调用这个 —— FK cascade 已经清掉了；
   * 这是 UI 里"清空这门课的错词"按钮用的，例如用户重传了同课、想从头来。
   */
  clearLesson: protectedProcedure
    .input(z.object({ lessonId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(wrongWords)
        .where(
          and(
            eq(wrongWords.userId, ctx.user.id),
            eq(wrongWords.lessonId, input.lessonId),
          ),
        )
      // 清不存在的 lessonId 也是合法的静默 NOOP（inArray 已 throw NOT_FOUND 没必要）
      return { ok: true }
    }),

  /**
   * 给路由内「批量预热」用的：根据一组 id 取详情。在 wb.tsx 的列表点击「练」时，
   * 没必要再走一次 list，路由里直接拿当前行数组就够；这里保留用于未来别处要查。
   */
  byIds: protectedProcedure
    .input(z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(wrongWords)
        .where(
          and(
            eq(wrongWords.userId, ctx.user.id),
            inArray(wrongWords.id, input.ids),
          ),
        )
      return rows
    }),
})
