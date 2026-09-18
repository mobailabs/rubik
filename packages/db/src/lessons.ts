import { relations } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { user } from "./user"

export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    audioUrl: text("audio_url").notNull(),
    source: text("source"),
    model: text("model"),
    duration: real("duration"),
    confFloor: real("conf_floor"),
    sentenceCount: integer("sentence_count").notNull().default(0),
    wordCount: integer("word_count").notNull().default(0),
    content: jsonb("content").notNull(),
    // 纯私有模型下恒为 "private"，可见性只由 ownerId 决定（见 apps/api 的 lesson router）。
    // 字段先留着，不为将来做共享题库再动一次表结构。
    visibility: text("visibility").notNull().default("private"),
    // ready | pending（等本机转写守护脚本回填） | failed
    status: text("status").notNull().default("ready"),
    error: text("error"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("lessons_owner_idx").on(table.ownerId)],
)

export const lessonRelations = relations(lessons, ({ one }) => ({
  owner: one(user, { fields: [lessons.ownerId], references: [user.id] }),
}))
