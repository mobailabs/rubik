import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { user } from "./user"
import { lessons } from "./lessons"

/**
 * 错词本。
 *
 * 同一用户在同一课的同一词只占一行 —— UNIQUE(user_id, lesson_id, word_norm)，
 * 再错一次只 n++ / last_seen_at 更新，数据有界。
 *
 * `lessons.id` 是 onDelete cascade：删课时连带清掉对应行的音频切片（音频对象都没了，
 * 留着也只能显示「已失效」），见 apps/web/src/routes/dashboard/practice/index.tsx
 * 的删课确认卡文案。`users.id` 也是 cascade（用户注销一并走）。
 *
 * `word_norm` 是归一化后的词（小写、去标点），用于去重；
 * `display` 保留原大小写 / 撇号，给 UI 显示用 —— DB 不能再 normalize 后
 * 帮用户把 "Don't" 改成 "don't"。
 */
export const wrongWords = pgTable(
  "wrong_words",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    wordNorm: text("word_norm").notNull(),
    display: text("display").notNull(),
    audioUrl: text("audio_url").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    n: integer("n").notNull().default(1),
    mastered: boolean("mastered").notNull().default(false),
    /**
     * 极简调度（不是 SRS）：`good` 是连续答对次数，`due_at` 是下次该出现的时刻。
     * 答对 → good++，间隔 2/4/8/16/30 天推进，good 满 5 自动 mastered；
     * 答错 → good 归零、明天再来。见 `apps/api/src/trpc/routers/wb.ts` 的 `grade`。
     *
     * 默认 now()：新记的错词立刻到期，第一次打开错词本就能练。
     */
    good: integer("good").notNull().default(0),
    dueAt: timestamp("due_at").notNull().defaultNow(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wrong_words_user_lesson_word_uidx").on(
      table.userId,
      table.lessonId,
      table.wordNorm,
    ),
    index("wrong_words_user_mastered_last_idx").on(
      table.userId,
      table.mastered,
      table.lastSeenAt,
    ),
    // 「今天该练哪些」是错词本的默认视图，单独给它一个索引
    index("wrong_words_user_due_idx").on(table.userId, table.dueAt),
  ],
)

export const wrongWordRelations = relations(wrongWords, ({ one }) => ({
  user: one(user, { fields: [wrongWords.userId], references: [user.id] }),
  lesson: one(lessons, {
    fields: [wrongWords.lessonId],
    references: [lessons.id],
  }),
}))

// TS 类型导出方便 router / 组件两侧复用
export type WrongWordRow = typeof wrongWords.$inferSelect
export type WrongWordInsert = typeof wrongWords.$inferInsert

// 防止 tsx 引用后告 unused —— 这个 sql 仅在创建行时由 defaultNow 提供，
// 这里再写一遍是给 gen_random_uuid() 风格的 helper 留位（目前 id 由客户端生成）。
void sql
