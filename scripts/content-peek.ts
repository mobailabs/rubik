import { neon } from "@neondatabase/serverless"
const url = process.env.DATABASE_URL!
const sql = neon(url)
async function main() {
  const rows = await sql`select id, content from "lessons" limit 2`
  for (const r of rows as any[]) {
    console.log(`\n=== ${r.id} ===`)
    console.log(JSON.stringify(r.content, null, 2).slice(0, 1500))
  }
}
main().catch((e)=>{console.error("ERR:",(e as Error).message);process.exit(1)})
