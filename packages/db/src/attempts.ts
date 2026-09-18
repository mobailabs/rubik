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
import { lessons } from "./lessons"

export const attempts = pgTable(
  "attempts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    accuracy: real("accuracy"),
    wpm: real("wpm"),
    durationSec: real("duration_sec"),
    details: jsonb("details"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("attempts_user_lesson_idx").on(table.userId, table.lessonId),
    index("attempts_user_created_idx").on(table.userId, table.createdAt),
  ],
)

export const attemptRelations = relations(attempts, ({ one }) => ({
  user: one(user, { fields: [attempts.userId], references: [user.id] }),
  lesson: one(lessons, {
    fields: [attempts.lessonId],
    references: [lessons.id],
  }),
}))
