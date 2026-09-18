import { desc } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { user } from "./user"

/**
 * 管理员操作的流水：谁在什么时候把谁的角色改成了什么。
 *
 * actorId / targetId 用 set null —— 账号被删之后记录仍要留着（审计的意义就在这里），
 * 页面侧对 null 显示「已注销用户」。
 */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    targetId: text("target_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // role.grant | role.revoke
    action: text("action").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("admin_audit_created_idx").on(desc(table.createdAt))],
)
