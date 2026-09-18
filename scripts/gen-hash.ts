import { hashPassword, verifyPassword } from "@better-auth/utils/dist/password.mjs"
import { neon } from "@neondatabase/serverless"

const url = process.env.DATABASE_URL!
const sql = neon(url)
const NEW_PW = process.env.NEW_PW || "mikey1234"

async function main() {
  const hash = await hashPassword(NEW_PW)
  console.log("GEN_HASH:", hash)

  // sanity: verify it round-trips
  const ok = await verifyPassword(hash, NEW_PW)
  console.log("VERIFY_SELF:", ok)

  const upd = await sql`
    update "account" set password = ${hash}
    where provider_id = 'credential'
      and user_id = (select id from "user" where email = 'mikey@gmail.com')
    returning account_id`
  console.log("UPDATED:", JSON.stringify(upd))
}
main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
