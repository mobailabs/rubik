/**
 * 删课：同时删掉 S3 上的音频对象和数据库行。
 *
 * 用法：
 *   node --env-file=apps/api/.dev.vars 方式不方便（键值里有 = ），所以这里直接
 *   从 apps/api/.dev.vars 里读：
 *   ./packages/db/node_modules/.bin/tsx scripts/delete-lesson.ts <lessonId> [...]
 */
import { neon } from "@neondatabase/serverless"
import { deleteObject } from "../apps/api/src/lib/s3"
import { readFileSync } from "node:fs"

function loadEnv(): Record<string, string> {
  const path = new URL("../apps/api/.dev.vars", import.meta.url).pathname
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = loadEnv()
const s3Env = {
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_REGION: env.S3_REGION,
  S3_BUCKET: env.S3_BUCKET,
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
}

async function main() {
  const ids = process.argv.slice(2)
  if (!ids.length) throw new Error("用法：tsx scripts/delete-lesson.ts <lessonId> [...]")

  const sql = neon(env.DATABASE_URL)
  for (const id of ids) {
    const rows = await sql`select id, audio_url from lessons where id = ${id}`
    if (!rows.length) {
      console.log(`跳过（不存在）：${id}`)
      continue
    }
    const audioUrl = String(rows[0].audio_url)
    // https://s3.wiseme.ren/temp/tts/xxx.wav -> tts/xxx.wav
    const marker = `/${s3Env.S3_BUCKET}/`
    const idx = audioUrl.indexOf(marker)
    const key = idx >= 0 ? audioUrl.slice(idx + marker.length) : ""
    if (key) {
      try {
        await deleteObject(s3Env as never, key)
        console.log(`  已删 S3 对象：${key}`)
      } catch (e) {
        console.log(`  S3 删除失败（继续删库）：${(e as Error).message}`)
      }
    } else {
      console.log(`  音频地址不在本桶，跳过对象删除：${audioUrl}`)
    }
    await sql`delete from lessons where id = ${id}`
    console.log(`  已删课程：${id}`)
  }
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message)
  process.exit(1)
})
