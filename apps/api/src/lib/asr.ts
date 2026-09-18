/**
 * 音频转写：把音频交给 omlx（whisper）拿词级时间戳，再清洗成练习引擎认的句子结构。
 *
 * omlx 的公网入口 https://omlx.wiseme.ren 由 Mac mini 上的 cloudflared 隧道暴露
 * （隧道 ingress: omlx.wiseme.ren -> localhost:9200），Worker 直连即可，
 * 不需要任何旁路进程或队列 —— 转写就是这个请求的一部分。
 */

export type AsrEnv = {
  ASR_API: string
  ASR_MODEL: string
  ASR_KEY: string
}

type AsrWord = { word?: string; start?: number; end?: number; probability?: number }
type AsrSegment = { start?: number; end?: number; text?: string; words?: AsrWord[] }
type AsrResponse = { segments?: AsrSegment[] }

/** 引擎侧认识的词结构：w=词形 s=起 e=止 p=置信度 */
export type LessonWord = { w: string; s: number; e: number; p: number }
export type Sentence = {
  start: number
  end: number
  text: string
  low_conf: string[]
  words: LessonWord[]
}

export const CONF_FLOOR = 0.85 // 低于此置信度的词标记为"存疑"
const MIN_SEGMENT_CHARS = 2 // 少于这个字符数的段落丢掉

/** 转写等待上限。再长就该考虑把音频切短了（Cloudflare 请求本身也扛不住太久）。 */
const TRANSCRIBE_TIMEOUT_MS = 90_000

const round = (n: number, digits: number) => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export async function transcribe(
  env: AsrEnv,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<AsrResponse> {
  if (!env.ASR_KEY) throw new Error("未配置 ASR_KEY（wrangler secret / .dev.vars）")
  const api = (env.ASR_API || "").replace(/\/+$/, "")
  const model = env.ASR_MODEL
  if (!api || !model) throw new Error("未配置 ASR_API / ASR_MODEL")

  const form = new FormData()
  form.set("model", model)
  form.set("language", "en") // 强制英文，避免混入中文
  form.set("word_timestamps", "true")
  form.set("response_format", "json")
  form.set("temperature", "0")
  form.set("file", new Blob([bytes], { type: contentType }), filename)

  let res: Response
  try {
    res = await fetch(`${api}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ASR_KEY}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (e) {
    const msg = (e as Error).message || ""
    if (/abort|timeout/i.test(msg)) {
      throw new Error(`转写超时（超过 ${TRANSCRIBE_TIMEOUT_MS / 1000}s），音频可能太长或转写服务忙`)
    }
    throw new Error(`连不上转写服务：${msg}`)
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`转写服务返回 ${res.status}${text ? `：${text}` : ""}`)
  }
  return (await res.json()) as AsrResponse
}

// ---------- 清洗 ----------

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const TAGS = /<\|[^|]*\|>|<[^>]{0,20}>/g

function cleanText(s: string): string {
  return s
    .replace(TAGS, " ")
    .replace(/\u200b/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .trim()
}

/** 按字符构成判断这段是不是英语。 */
function isEnglish(s: string): boolean {
  const letters = [...s].filter((c) => /\p{L}/u.test(c))
  if (!letters.length) return false
  if (CJK.test(s)) return false
  const ascii = letters.filter((c) => c.codePointAt(0)! < 128).length
  return ascii / letters.length >= 0.8
}

/** 把 ASR 的词表整理成 [{w,s,e,p}]，并保证时间戳单调、落在句内。 */
function buildWords(raw: AsrWord[] | undefined, segStart: number, segEnd: number): LessonWord[] {
  const out: LessonWord[] = []
  for (const item of raw ?? []) {
    const w = cleanText(item.word ?? "")
    if (!w) continue

    const rawStart = item.start ?? segStart
    const rawEnd = item.end ?? rawStart
    if (!Number.isFinite(Number(rawStart)) || !Number.isFinite(Number(rawEnd))) continue

    let s = Number(rawStart)
    let e = Number(rawEnd)
    let p = Number(item.probability ?? 1)
    if (!Number.isFinite(p)) p = 1

    s = Math.max(s, segStart)
    e = Math.min(Math.max(e, s), segEnd)
    const last = out[out.length - 1]
    if (last && s < last.e) {
      s = last.e
      e = Math.max(e, s)
    }
    out.push({ w, s: round(s, 3), e: round(e, 3), p: round(p, 3) })
  }
  return out
}

export function buildLesson(asr: AsrResponse) {
  const sentences: Sentence[] = []
  let dropped = 0

  for (const seg of asr.segments ?? []) {
    const text = cleanText(seg.text ?? "")
    if (text.length < MIN_SEGMENT_CHARS || !isEnglish(text)) {
      dropped++
      continue
    }

    const rawStart = seg.start ?? 0
    const rawEnd = seg.end ?? rawStart
    if (!Number.isFinite(Number(rawStart)) || !Number.isFinite(Number(rawEnd))) {
      dropped++
      continue
    }

    let start = Number(rawStart)
    let end = Number(rawEnd)
    if (end - start < 0.25) {
      dropped++
      continue
    }

    const words = buildWords(seg.words, start, end)
    if (!words.length) {
      dropped++
      continue
    }

    // 用词级时间戳收紧句子边界
    start = Math.min(words[0].s, start)
    end = Math.max(words[words.length - 1].e, end)

    sentences.push({
      start: round(start, 3),
      end: round(end, 3),
      text,
      low_conf: words.filter((w) => w.p < CONF_FLOOR).map((w) => w.w),
      words,
    })
  }

  // duration 字段接口恒返回 0，用末段兜底
  const duration = sentences.reduce((m, s) => Math.max(m, s.end), 0)

  return {
    sentences,
    sentenceCount: sentences.length,
    wordCount: sentences.reduce((n, s) => n + s.words.length, 0),
    duration: round(duration, 2),
    dropped,
  }
}
