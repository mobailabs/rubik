/**
 * 上传音频 → 存 S3 → 转写 → 建课。整条链路就在这一个请求里跑完。
 *
 *   浏览器 --(音频)--> Worker /api/upload --+--> S3(MinIO)          音频长期存放
 *                                            +--> omlx.wiseme.ren    转写（whisper）
 *                                            +--> lessons            content + 统计
 *
 * 返回时课程已经是可练习状态（status=ready），不需要任何后台消费者。
 * 转写失败也没关系：音频和记录都留着，课程标成 failed 并带上原因，可重传。
 */
import { Hono } from "hono"
// drizzle-orm 不是 api 的直接依赖，eq 由 @repo/db 转出（和 lesson router 一致）
import { createDB, and, eq, lessons } from "@repo/db"
import { createAuth } from "../auth"
import { putObject, publicUrl } from "../lib/s3"
import { CONF_FLOOR, buildLesson, transcribe } from "../lib/asr"

type UploadEnv = {
  DATABASE_URL: string
  S3_ENDPOINT: string
  S3_REGION: string
  S3_BUCKET: string
  S3_PREFIX: string
  S3_PUBLIC_BASE_URL: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  ASR_API: string
  ASR_MODEL: string
  ASR_KEY: string
}

const AUDIO_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
}
const MAX_BYTES = 60 * 1024 * 1024 // Worker 请求体上限之下留余量

const app = new Hono<{ Bindings: UploadEnv }>()

function bad(c: { json: (v: unknown, s: number) => Response }, msg: string, status = 400) {
  return c.json({ ok: false, error: msg }, status)
}

/** 用文件名造一个稳定的 id：去掉怪字符，末尾加 6 位随机避免撞车。 */
function lessonIdFrom(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "")
  const slug =
    stem
      .normalize("NFKD")
      .replace(/[^\w一-龥-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "lesson"
  const rand = Math.random().toString(36).slice(2, 8)
  return `${slug}_${rand}`
}

app.post("/api/upload", async (c) => {
  const session = await createAuth(c.env as unknown as Parameters<typeof createAuth>[0]).api.getSession({
    headers: c.req.raw.headers,
  })
  if (!session) return bad(c, "未登录", 401)

  const rawName = c.req.header("x-filename") || "audio.wav"
  let filename = "audio.wav"
  try {
    filename = decodeURIComponent(rawName) || filename
  } catch {
    /* 文件名没编码就按原样用 */
  }
  filename = filename.split(/[\\/]/).pop() || "audio.wav"

  const ext = (filename.split(".").pop() || "").toLowerCase()
  const contentType = c.req.header("content-type") || AUDIO_EXT[ext] || "application/octet-stream"
  const isAudio = contentType.startsWith("audio/") || Boolean(AUDIO_EXT[ext])
  if (!isAudio) return bad(c, `不支持的音频格式：.${ext || "?"}`)

  const db = createDB(c.env.DATABASE_URL)
  const [dup] = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(and(eq(lessons.ownerId, session.user.id), eq(lessons.source, filename)))
    .limit(1)
  if (dup) return c.json({ ok: false, skipped: true, error: "文件名已存在" }, 409)

  const len = Number(c.req.header("content-length") || 0)
  if (len && len > MAX_BYTES) return bad(c, "文件太大（上限 60MB）", 413)

  const body = await c.req.arrayBuffer()
  if (body.byteLength > MAX_BYTES) return bad(c, "文件太大（上限 60MB）", 413)
  if (body.byteLength < 1024) return bad(c, "文件内容为空或过小")

  const id = lessonIdFrom(filename)
  const title = filename.replace(/\.[^.]+$/, "")
  const prefix = (c.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "")
  const key = `${prefix ? prefix + "/" : ""}${id}.${ext}`

  try {
    await putObject(c.env, key, body, contentType)
  } catch (e) {
    return bad(c, `音频上传失败：${(e as Error).message}`, 502)
  }

  const audioUrl = publicUrl(c.env, key)
  // 先落一条 pending：万一转写这步断了，也能看出是卡在哪儿，音频也还在
  await db.insert(lessons).values({
    id,
    title,
    audioUrl,
    source: filename,
    content: [],
    status: "pending",
    visibility: "private",
    ownerId: session.user.id,
  })

  let lesson
  try {
    const asr = await transcribe(c.env, body, filename, contentType)
    lesson = buildLesson(asr)
    if (lesson.sentenceCount === 0) {
      throw new Error("没识别出可用的句子（音频太短 / 不是英语 / 几乎全是静音）")
    }
  } catch (e) {
    const msg = (e as Error).message
    await db
      .update(lessons)
      .set({ status: "failed", error: msg.slice(0, 500) })
      .where(eq(lessons.id, id))
    return bad(c, `转写失败：${msg}`, 502)
  }

  const [row] = await db
    .update(lessons)
    .set({
      status: "ready",
      error: null,
      content: lesson.sentences as never,
      sentenceCount: lesson.sentenceCount,
      wordCount: lesson.wordCount,
      duration: lesson.duration,
      model: c.env.ASR_MODEL,
      confFloor: CONF_FLOOR,
    })
    .where(eq(lessons.id, id))
    .returning()

  return c.json({
    ok: true,
    id: row.id,
    title: row.title,
    audioUrl,
    status: "ready",
    sentenceCount: lesson.sentenceCount,
    wordCount: lesson.wordCount,
    duration: lesson.duration,
  })
})

export default app
