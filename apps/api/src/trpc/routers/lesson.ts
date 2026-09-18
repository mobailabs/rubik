import { TRPCError } from "@trpc/server"
import { and, attempts, desc, eq, gte, lessons, sql } from "@repo/db"
import { z } from "zod"
import { protectedProcedure, router } from "../init"
import { deleteObject, objectKeyFromUrl } from "../../lib/s3"

/**
 * 课程是纯私有资源：一门课只归它创建者，别人（含未登录）一概读不到。
 *
 * 早先是 publicProcedure + 「public 的全给、自己的 private 也给」，结果是
 * 任何新注册用户一进来就看到别人库里的课。这里把可见性收成一条：
 * ownerId === 本人。visibility 列保留但不再参与判定（见 packages/db/src/lessons.ts）。
 */
export const lessonRouter = router({
  list: protectedProcedure.query(
    async ({ ctx }) =>
      await ctx.db
        .select()
        .from(lessons)
        .where(eq(lessons.ownerId, ctx.user.id))
        .orderBy(desc(lessons.createdAt)),
  ),

  /**
   * 每门课的练习进度：练过几轮、上次多少分、上次什么时候练的、今天练了多久。
   *
   * 单独一个接口而不是折进 `list`：`list` 是每次进课程页的必经查询，而进度只在
   * 课程卡上显示 —— 折进去会让那个必经查询多背一个 group by，收益不值。
   *
   * 一次 group by 拿全（库在新加坡，按 lessonId 逐个查就是 N 个跨洋往返）：
   * `count` / `max(accuracy)` 走 FILTER 或聚合，近 7 天的最近一次用窗口函数。
   *
   * `lastAccuracy` 取的是**最近一次**而不是最高一次：课程卡要回答的是「我上次
   * 练成什么样」，最高分会骗人（上次 60% 但历史上蒙到过 95%）。
   */
  progress: protectedProcedure.query(async ({ ctx }) => {
    const since = new Date(Date.now() - 7 * 86_400_000)

    const rows = await ctx.db
      .select({
        lessonId: attempts.lessonId,
        rounds: sql<number>`count(*)::int`,
        lastAccuracy: sql<number | null>`(array_agg(${attempts.accuracy} order by ${attempts.createdAt} desc))[1]`,
        lastAt: sql<Date | null>`max(${attempts.createdAt})`,
        // 今天练了多久：只算今天，用来在卡上标「今日剂量已够」
        todaySec: sql<number>`coalesce(sum(${attempts.durationSec}) filter (where ${attempts.createdAt} >= current_date), 0)::int`,
      })
      .from(attempts)
      .where(
        and(
          eq(attempts.userId, ctx.user.id),
          gte(attempts.createdAt, since),
        ),
      )
      .groupBy(attempts.lessonId)

    return rows.map((r) => ({
      lessonId: r.lessonId,
      rounds: r.rounds,
      // accuracy 可空（旧记录 / 未记分的那次），空就原样给出，让前端决定怎么显示
      lastAccuracy: r.lastAccuracy,
      lastAt: r.lastAt,
      todaySec: r.todaySec,
    }))
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [lesson] = await ctx.db
        .select()
        .from(lessons)
        .where(eq(lessons.id, input.id))
      // 不是自己的课一律 NOT_FOUND：连「存在但没权限」都不透露。
      if (!lesson || lesson.ownerId !== ctx.user.id)
        throw new TRPCError({ code: "NOT_FOUND" })
      return lesson
    }),

  create: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        audioUrl: z.string().url(),
        source: z.string().optional(),
        model: z.string().optional(),
        duration: z.number().optional(),
        confFloor: z.number().optional(),
        sentenceCount: z.number().int().optional(),
        wordCount: z.number().int().optional(),
        content: z.any(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [lesson] = await ctx.db
        .insert(lessons)
        .values({
          id: input.id,
          title: input.title,
          audioUrl: input.audioUrl,
          source: input.source,
          model: input.model,
          duration: input.duration,
          confFloor: input.confFloor,
          sentenceCount: input.sentenceCount ?? 0,
          wordCount: input.wordCount ?? 0,
          content: input.content,
          // visibility 不再由调用方给：纯私有模型下恒为 private。
          visibility: "private",
          ownerId: ctx.user.id,
        })
        .returning()
      return lesson
    }),

  /**
   * 删课。口径与 `get` 一致：不是自己的课一律 NOT_FOUND（不透露存在性）。
   *
   * `attempts.lesson_id` 是 onDelete cascade，这门课的练习记录跟着一起走。
   *
   * 库行删完后再删桶里的音频对象：先删库、后删对象，对象删除失败只记日志、
   * 不阻断（音频漏删总比课删不掉好）。`objectKeyFromUrl` 会校验 bucket 与 host
   * 才返回 key，杜绝误删别的桶 / 别来源的对象。
   */
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [lesson] = await ctx.db
        .select()
        .from(lessons)
        .where(eq(lessons.id, input.id))
      if (!lesson || lesson.ownerId !== ctx.user.id)
        throw new TRPCError({ code: "NOT_FOUND" })
      await ctx.db.delete(lessons).where(eq(lessons.id, input.id))
      const key = objectKeyFromUrl(ctx.s3, lesson.audioUrl)
      if (key) {
        try {
          await deleteObject(ctx.s3, key)
        } catch (e) {
          console.error("删除课程音频对象失败", e)
        }
      }
      return { id: input.id }
    }),
})
