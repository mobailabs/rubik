/**
 * 给 wrong_words 加 due_at / good 两列（一次性）。
 *
 * 不用 drizzle-kit push：它会把 schema 里没有的表（threads / user_profiles /
 * _hub_migrations / neon_auth.*）当成"要删掉"，交互式确认也跑不起来。
 *
 * 语义：due_at = 这个词下一次该出现的时间；good = 连续答对次数，
 * 间隔按 2/4/8/16/30 天推进，答错归零、明天再来。
 *
 * 用法：
 *   DATABASE_URL=$(grep '^DATABASE_URL' apps/api/.dev.vars | cut -d= -f2-) \
 *     ./packages/db/node_modules/.bin/tsx scripts/add-wb-due.ts
 */
import { neon } from "@neondatabase/serverless"

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL 未设置")
  const sql = neon(url)

  await sql`alter table wrong_words add column if not exists due_at timestamptz not null default now()`
  await sql`alter table wrong_words add column if not exists good integer not null default 0`
  await sql`create index if not exists wrong_words_user_due_idx on wrong_words (user_id, due_at)`

  const cols = await sql`
    select column_name, data_type from information_schema.columns
    where table_name = 'wrong_words' order by ordinal_position`
  console.log(
    "COLS:",
    cols.map((r: { column_name: string }) => r.column_name).join(", "),
  )

  const rows = await sql`
    select word_norm, good, due_at, mastered from wrong_words limit 10`
  console.log("ROWS:", JSON.stringify(rows))
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
