import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Pool } from "@neondatabase/serverless"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "../..")
const txt = readFileSync(resolve(root, "apps/api/.dev.vars"), "utf8")
const env = {}
for (const line of txt.split("\n")) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m) env[m[1]]=m[2] }
const direct = env.DATABASE_URL.replace("-pooler","")
const pool = new Pool({ connectionString: direct })
const c = await pool.connect()
try {
  const before = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
  console.log("BEFORE:", before.rows.map(r=>r.table_name).join(", "))

  const migrationFile = resolve(root, "packages/db/drizzle/0000_redundant_medusa.sql")
  let migration = readFileSync(migrationFile,"utf8").replace(/--> statement-breakpoint\s*/g,"\n")
  const statements = migration.split(";").map(s=>s.trim()).filter(Boolean)
  console.log(`\napplying ${statements.length} statements (persistent connection)...`)
  for (const st of statements) {
    try { await c.query(st); console.log("OK ->", st.slice(0,55).replace(/\s+/g," ")) }
    catch (e) { console.log("ERR ->", st.slice(0,55).replace(/\s+/g," "), "::", e.message) }
  }
  const after = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('lessons','attempts')")
  console.log("\nAFTER lessons/attempts:", after.rows.map(r=>r.table_name).join(", ") || "NONE")
  const lc = await c.query("SELECT count(*)::int AS c FROM lessons")
  const ac = await c.query("SELECT count(*)::int AS c FROM attempts")
  console.log("lessons count:", lc.rows[0].c, "| attempts count:", ac.rows[0].c)
} finally { c.release(); await pool.end() }
