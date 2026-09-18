import { config } from "dotenv"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Pool } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-serverless"
import { lessons } from "@repo/db"

config({ path: resolve(import.meta.dirname, "../apps/api/.dev.vars") })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error("DATABASE_URL missing")

// local node can't use the pooler HTTP driver reliably for writes/read-back;
// use the direct (non-pooler) endpoint with a persistent WebSocket connection.
const DIRECT = DATABASE_URL.replace("-pooler", "")

const SRC =
  "/Users/zhaopeng/WorkBuddy/2026-09-10-17-22-30/english-typing/lessons"

const AUDIO: Record<string, string> = {
  doubao_tts_1789035694967:
    "https://s3.wiseme.ren/temp/tts/doubao_tts_1789035694967.wav",
  doubao_tts_1789116112773:
    "https://s3.wiseme.ren/temp/tts/doubao_tts_1789116112773.wav",
}

const FILES = [
  "doubao_tts_1789035694967.json",
  "doubao_tts_1789116112773.json",
]

async function main() {
  const pool = new Pool({ connectionString: DIRECT })
  const db = drizzle(pool, { schema: { lessons } })

  for (const file of FILES) {
    const raw = JSON.parse(
      readFileSync(`${SRC}/${file}`, "utf8"),
    ) as Record<string, unknown>
    const id = raw.id as string
    const audioUrl = AUDIO[id]
    if (!audioUrl) throw new Error(`No S3 audio URL for ${id}`)

    const [row] = await db
      .insert(lessons)
      .values({
        id,
        title: (raw.title as string) ?? id,
        audioUrl,
        source: raw.source as string | undefined,
        model: raw.model as string | undefined,
        duration: raw.duration as number | undefined,
        confFloor: raw.conf_floor as number | undefined,
        sentenceCount: (raw.sentence_count as number) ?? 0,
        wordCount: (raw.word_count as number) ?? 0,
        content: raw.sentences,
        visibility: "public",
      })
      .onConflictDoUpdate({
        target: lessons.id,
        set: {
          title: (raw.title as string) ?? id,
          audioUrl,
          source: raw.source as string | undefined,
          model: raw.model as string | undefined,
          duration: raw.duration as number | undefined,
          confFloor: raw.conf_floor as number | undefined,
          sentenceCount: (raw.sentence_count as number) ?? 0,
          wordCount: (raw.word_count as number) ?? 0,
          content: raw.sentences,
        },
      })
      .returning()

    console.log(`seeded ${row.id} (${row.sentenceCount} sentences)`)
  }

  await pool.end()
  console.log("done")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
