import { TRPCError } from "@trpc/server"
import { desc, eq, attempts, lessons, sql, wrongWords } from "@repo/db"
import { z } from "zod"
import { protectedProcedure, router } from "../init"

/**
 * 引擎写进 `attempts.details` 的形状（见 apps/web/src/lib/engine/types.ts 的 AttemptPayload）。
 *
 * 这里只声明统计页用得到的部分，且全部按**可选**处理：这个字段是 z.any() 写进来的，
 * 历史行可能缺字段、也可能是更早版本的形状。少一个字段不该让整页挂掉。
 */
type AttemptLogEntry = { n?: number; sec?: number; listens?: number; kinds?: Record<string, number> }
type AttemptDetails = {
  types?: Record<string, number>
  log?: AttemptLogEntry[]
  tier?: number
  totalSlots?: number
}

/** 把 jsonb 里的秒数加起来。字段缺失/非数字一律当 0，别让 NaN 污染整轮累加。 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export const attemptRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    await ctx.db
      .select()
      .from(attempts)
      .where(eq(attempts.userId, ctx.user.id))
      .orderBy(desc(attempts.createdAt)),
  ),

  /**
   * 统计页的全部数据，一次请求返回。
   *
   * 为什么在服务端聚合：`details` 里逐句记录了 sec / listens，
   * 全量拉到前端再 reduce，等于把整个练习史（每次几百条）都过一次网线。
   * 实测一条 log 条目约 40 字节，练 100 轮就是几千条 —— 聚合放这里，
   * 前端只拿最终几十个数字。
   *
   * 两个数据源：
   *   - `attempts`：练习本身（时长、正确率、逐句耗时、错误分类）
   *   - `wrong_words`：错词本（到期、已会、最常错的词）
   * 它们回答的是不同问题（「我练得怎么样」vs「我还有什么没掌握」），
   * 但都归"统计"，所以合并成一个接口，省一次跨洋往返。
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: attempts.id,
        lessonId: attempts.lessonId,
        accuracy: attempts.accuracy,
        durationSec: attempts.durationSec,
        details: attempts.details,
        createdAt: attempts.createdAt,
      })
      .from(attempts)
      .where(eq(attempts.userId, ctx.user.id))
      .orderBy(desc(attempts.createdAt))

    // ---- 总体盘子 ----
    let totalSec = 0
    let totalSentences = 0
    let totalListens = 0
    let totalSlots = 0
    // 错误分类：details.types 是结算时按类型汇总的（听错/留空/漏尾/多尾/手滑/存疑）
    const errorTotals: Record<string, number> = {}
    // 逐句 → 句子难度榜。按 (课, 句号) 聚合，因为同一个句子在每轮都会被记一次，
    // 只取最大耗时不代表它真的难（可能只是一边练一边走神），所以取**平均**并展示轮数。
    const sentenceMap = new Map<
      string,
      { lessonId: string; n: number; sumSec: number; sumListens: number; rounds: number; wrong: number }
    >()
    const accuracies: number[] = []

    for (const r of rows) {
      totalSec += num(r.durationSec)
      if (typeof r.accuracy === "number") accuracies.push(r.accuracy)

      const d = (r.details ?? null) as AttemptDetails | null
      if (!d) continue
      totalSlots += num(d.totalSlots)

      for (const [k, v] of Object.entries(d.types ?? {})) {
        errorTotals[k] = (errorTotals[k] ?? 0) + num(v)
      }

      for (const e of d.log ?? []) {
        totalSentences++
        totalListens += num(e.listens)
        const n = num(e.n)
        if (!n) continue
        const key = `${r.lessonId}#${n}`
        const cur =
          sentenceMap.get(key) ??
          { lessonId: r.lessonId, n, sumSec: 0, sumListens: 0, rounds: 0, wrong: 0 }
        cur.sumSec += num(e.sec)
        cur.sumListens += num(e.listens)
        cur.rounds++
        // 这一句这一轮除了 ok 之外还有别的判定 = 错了
        const kinds = e.kinds ?? {}
        const bad = Object.entries(kinds).some(([k, v]) => k !== "ok" && num(v) > 0)
        if (bad) cur.wrong++
        sentenceMap.set(key, cur)
      }
    }

    // 句子榜只保留"至少练过一轮且平均耗时明显偏长"的，按平均耗时降序。
    // 取前 15 条：再往后都是长尾，看一眼就够，不需要完整榜单。
    const hardest = [...sentenceMap.values()]
      .map((s) => ({
        lessonId: s.lessonId,
        n: s.n,
        avgSec: s.rounds ? s.sumSec / s.rounds : 0,
        avgListens: s.rounds ? s.sumListens / s.rounds : 0,
        rounds: s.rounds,
        wrongRounds: s.wrong,
      }))
      .sort((a, b) => b.avgSec - a.avgSec)
      .slice(0, 15)

    // ---- 错词本那侧 ----
    const [wbRow] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        mastered: sql<number>`count(*) filter (where ${wrongWords.mastered})::int`,
        due: sql<number>`count(*) filter (where not ${wrongWords.mastered} and ${wrongWords.dueAt} <= now())::int`,
        hits: sql<number>`coalesce(sum(${wrongWords.n}), 0)::int`,
      })
      .from(wrongWords)
      .where(eq(wrongWords.userId, ctx.user.id))

    // 最常错的词：n 是"错过几次"，跨课合并（同一个词在多门课错，合起来才是真实的薄弱点）
    const topWrong = await ctx.db
      .select({
        word: wrongWords.wordNorm,
        display: wrongWords.display,
        hits: sql<number>`sum(${wrongWords.n})::int`,
        lessons: sql<number>`count(*)::int`,
      })
      .from(wrongWords)
      .where(eq(wrongWords.userId, ctx.user.id))
      .groupBy(wrongWords.wordNorm, wrongWords.display)
      .orderBy(sql`sum(${wrongWords.n}) desc`)
      .limit(12)

    // 错词分布在哪几门课 —— 单独查，不要拿 hardest 里的课去凑：
    // hardest 只取前 15 句，用它算"涉及课程"会少算，是个看着像真数据的假数。
    const wrongByLesson = await ctx.db
      .select({
        lessonId: wrongWords.lessonId,
        n: sql<number>`count(*)::int`,
      })
      .from(wrongWords)
      .where(eq(wrongWords.userId, ctx.user.id))
      .groupBy(wrongWords.lessonId)
      .orderBy(sql`count(*) desc`)
      .limit(20)

    return {
      totals: {
        rounds: rows.length,
        lessonCount: new Set(rows.map((r) => r.lessonId)).size,
        totalSec,
        totalSentences,
        totalListens,
        totalSlots,
        avgAccuracy: accuracies.length
          ? Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length)
          : null,
        avgSecPerSentence: totalSentences ? totalSec / totalSentences : 0,
        firstAt: rows.length ? rows[rows.length - 1]!.createdAt : null,
        lastAt: rows.length ? rows[0]!.createdAt : null,
      },
      errors: Object.entries(errorTotals)
        .map(([kind, n]) => ({ kind, n }))
        .sort((a, b) => b.n - a.n),
      hardest,
      wrongBook: {
        total: wbRow?.total ?? 0,
        mastered: wbRow?.mastered ?? 0,
        due: wbRow?.due ?? 0,
        hits: wbRow?.hits ?? 0,
        top: topWrong,
        byLesson: wrongByLesson,
      },
    }
  }),

  /**
   * 记一次练习成绩。
   *
   * 课必须存在且属于本人 —— 口径与 lesson.get / wb.record 一致，不是自己的课一律
   * NOT_FOUND（不透露存在性）。不校验的话有两条路进来：
   * `attempts.lesson_id` 的外键是 on delete cascade、不是 not-null-in-parent，
   * 随便编一个 id 就能插进来，progress 页随后读出一条挂空的记录；而真实存在的
   * 课程 id 是公开可枚举的，别人能把自己的成绩挂到你的课上。
   */
  save: protectedProcedure
    .input(
      z.object({
        lessonId: z.string(),
        score: z.number(),
        accuracy: z.number().optional(),
        wpm: z.number().optional(),
        durationSec: z.number().optional(),
        details: z.any().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [lesson] = await ctx.db
        .select({ ownerId: lessons.ownerId })
        .from(lessons)
        .where(eq(lessons.id, input.lessonId))
      if (!lesson || lesson.ownerId !== ctx.user.id)
        throw new TRPCError({ code: "NOT_FOUND", message: "课程不存在或无权限" })

      const [row] = await ctx.db
        .insert(attempts)
        .values({
          userId: ctx.user.id,
          lessonId: input.lessonId,
          score: input.score,
          accuracy: input.accuracy,
          wpm: input.wpm,
          durationSec: input.durationSec,
          details: input.details,
        })
        .returning()
      return row
    }),
})
