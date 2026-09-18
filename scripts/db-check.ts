import { neon } from "@neondatabase/serverless"

const url = process.env.DATABASE_URL!
const sql = neon(url)

async function main() {
  // list auth-related tables
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
    order by table_name`
  console.log("TABLES:", tables.map((t: any) => t.table_name).join(", "))

  const users = await sql`
    select id, email, name, email_verified, created_at, image
    from "user" order by created_at desc nulls last limit 50`
  console.log("USER_COUNT:", users.length)
  console.log("USERS:", JSON.stringify(users, null, 2))

  const attempts = await sql`select count(*)::int as n from "attempts"`
  console.log("ATTEMPTS:", JSON.stringify(attempts))
  const lessons = await sql`select count(*)::int as n from "lessons"`
  console.log("LESSONS:", JSON.stringify(lessons))
}
main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
