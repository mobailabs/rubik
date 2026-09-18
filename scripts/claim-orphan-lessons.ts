/**
 * 把所有无主课程（owner_id is null）归给指定用户，并把它们的 visibility 收成 private。
 *
 * 为什么需要：课程改成纯私有后，可见性只由 owner_id 决定，owner 为空的课程
 * 会从所有人的视野里消失。早期那批种子课就是 owner=null / visibility=public，
 * 所以上线这套改动前必须先给它们找个主人。
 *
 * 幂等：只动 owner_id is null 的行，重跑不会改到已归属的课程。
 *
 * 用法：
 *   DATABASE_URL=$(grep '^DATABASE_URL' apps/api/.dev.vars | cut -d= -f2-) \
 *     ./packages/db/node_modules/.bin/tsx scripts/claim-orphan-lessons.ts [email]
 * 默认归给 mikey@gmail.com。
 */
import { neon } from "@neondatabase/serverless"

const DEFAULT_EMAIL = "mikey@gmail.com"

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL 未设置")
  const email = process.argv[2] || DEFAULT_EMAIL
  const sql = neon(url)

  const [owner] = await sql`select id, email from "user" where email = ${email}`
  if (!owner) throw new Error(`找不到用户：${email}`)

  const before = await sql`
    select count(*)::int as n from lessons where owner_id is null`
  console.log(`无主课程：${before[0].n} 门 → 归给 ${owner.email} (${owner.id})`)

  const claimed = await sql`
    update lessons
    set owner_id = ${owner.id}, visibility = 'private'
    where owner_id is null
    returning id`
  console.log(`已归属：${claimed.length} 门`)

  // schema 侧 lessons.visibility 的默认值也改成了 private，这里跟上，
  // 免得以后有人拿默认值当真。
  await sql`alter table lessons alter column visibility set default 'private'`
  console.log("lessons.visibility 默认值 → private")

  const rows = await sql`
    select l.id, l.visibility, u.email
    from lessons l left join "user" u on u.id = l.owner_id
    order by l.created_at`
  console.log("LESSONS:")
  for (const r of rows) console.log(`  ${r.id} | vis=${r.visibility} | owner=${r.email ?? "(无)"}`)

  const orphans = await sql`select count(*)::int as n from lessons where owner_id is null`
  console.log(`剩余无主课程：${orphans[0].n}`)
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
