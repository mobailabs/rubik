import { neon } from "@neondatabase/serverless"

const url = process.env.DATABASE_URL!
const sql = neon(url)

async function main() {
  const rows = await sql`select id, title, content from "lessons" limit 5`
  for (const r of rows as any[]) {
    const c = r.content
    const sents = c?.sentences ?? []
    console.log(`\n=== ${r.id} | ${r.title} | sentences=${sents.length} ===`)
    sents.slice(0, 3).forEach((s: any, i: number) => {
      const words = (s.words ?? []).map((w: any) => w.w).join(" ")
      console.log(`  S${i + 1}: ${words}`)
    })
    if (sents.length > 3) console.log(`  ... (+${sents.length - 3} more)`)
  }
}
main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
