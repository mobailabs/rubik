/**
 * admin 功能的建表/加列（一次性）。
 *
 * 为什么不用 drizzle-kit generate/migrate：`packages/db/drizzle` 的 journal 与线上库
 * 早已漂移 —— meta/0000_snapshot.json 里没有 lessons.status/error（当初是裸 SQL 加的），
 * 而线上库又有 schema 里没有的表（threads / user_profiles / _hub_migrations，属于同库的
 * 其它应用）。generate 出来的 SQL 直接跑会重复加列、push 则会判定要删表。
 * 所以按项目既有习惯走裸 SQL，且全部 if not exists，可重复执行。
 *
 * 用法：
 *   DATABASE_URL=$(grep '^DATABASE_URL' apps/api/.dev.vars | cut -d= -f2-) \
 *     ./packages/db/node_modules/.bin/tsx scripts/add-admin-columns.ts
 */
import { neon } from "@neondatabase/serverless"

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL 未设置")
  const sql = neon(url)

  await sql`do $$ begin
    create type user_role as enum ('user', 'admin');
  exception when duplicate_object then null; end $$`

  await sql`alter table "user" add column if not exists role user_role not null default 'user'`
  await sql`alter table "user" add column if not exists banned boolean not null default false`
  await sql`alter table "user" add column if not exists ban_reason text`
  await sql`alter table "user" add column if not exists ban_expires timestamp`

  await sql`alter table "session" add column if not exists impersonated_by text`

  await sql`create table if not exists admin_audit (
    id text primary key,
    actor_id text references "user"(id) on delete set null,
    target_id text references "user"(id) on delete set null,
    action text not null,
    detail jsonb not null,
    created_at timestamp not null default now()
  )`
  await sql`create index if not exists admin_audit_created_idx on admin_audit (created_at desc)`

  const cols = await sql`
    select table_schema, table_name, column_name from information_schema.columns
    where table_name in ('user', 'session', 'admin_audit')
    order by table_schema, table_name, ordinal_position`
  console.log(
    "COLS:",
    cols
      .map(
        (r: { table_schema: string; table_name: string; column_name: string }) =>
          `${r.table_schema}.${r.table_name}.${r.column_name}`,
      )
      .join(", "),
  )

  const roles = await sql`select role, count(*)::int as n from "user" group by role order by role`
  console.log("ROLES:", JSON.stringify(roles))
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
