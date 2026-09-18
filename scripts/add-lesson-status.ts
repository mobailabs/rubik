/**
 * 给 lessons 加 status / error 两列（一次性）。
 *
 * 不用 drizzle-kit push：它会把 schema 里没有的表（threads / user_profiles /
 * _hub_migrations）当成"要删掉"，交互式确认也跑不起来。
 *
 * 用法：
 *   DATABASE_URL=... pnpm exec tsx scripts/add-lesson-status.ts
 *   或直接：DATABASE_URL=$(grep '^DATABASE_URL' apps/api/.dev.vars | cut -d= -f2-) ./packages/db/node_modules/.bin/tsx scripts/add-lesson-status.ts
 */
import { neon } from "@neondatabase/serverless"

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL 未设置")
  const sql = neon(url)

  await sql`alter table lessons add column if not exists status text not null default 'ready'`
  await sql`alter table lessons add column if not exists error text`

  const cols = await sql`
    select column_name, data_type from information_schema.columns
    where table_name = 'lessons' order by ordinal_position`
  console.log("COLS:", cols.map((r: { column_name: string }) => r.column_name).join(", "))

  const rows = await sql`select id, status from lessons order by created_at desc limit 10`
  console.log("ROWS:", JSON.stringify(rows))
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
