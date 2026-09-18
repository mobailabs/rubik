import { neon } from "@neondatabase/serverless"
import crypto from "node:crypto"

const url = process.env.DATABASE_URL!
const sql = neon(url)
const NEW_PW = process.env.NEW_PW || "mikey1234"

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex")
  const key = crypto.scryptSync(password, Buffer.from(salt, "hex"), 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  })
  return `${salt}:${key.toString("hex")}`
}

async function main() {
  // show account columns + credential row for mikey
  const cols = await sql`select column_name from information_schema.columns where table_name='account' order by ordinal_position`
  console.log("ACCOUNT_COLS:", cols.map((c: any) => c.column_name).join(", "))

  const acc = await sql`
    select account_id, provider_id, password, user_id
    from "account" where provider_id = 'credential' limit 10`
  console.log("CREDENTIAL_ROWS:", JSON.stringify(acc, null, 2))

  // hash new password
  const hash = hashPassword(NEW_PW)
  console.log("NEW_HASH:", hash.slice(0, 20) + "...")

  // update the credential account whose user email = mikey@gmail.com
  const upd = await sql`
    update "account" set password = ${hash}
    where provider_id = 'credential'
      and user_id = (select id from "user" where email = 'mikey@gmail.com')
    returning account_id, provider_id`
  console.log("UPDATED:", JSON.stringify(upd))

  // also mark email verified true so login is unconditional
  await sql`update "user" set email_verified = true where email = 'mikey@gmail.com'`
  console.log("EMAIL_VERIFIED set true for mikey@gmail.com")
}
main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
