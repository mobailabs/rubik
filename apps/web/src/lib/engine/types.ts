export interface Word {
  w: string
  s: number
  e: number
  p?: number
}

export interface Sentence {
  start: number
  end: number
  text: string
  low_conf?: string[]
  words: Word[]
}

// DB 里 content 既可能是包成 { sentences } 的对象，也可能是裸的句子数组
export type LessonContent = Sentence[] | { sentences: Sentence[] }

export type SlotStateName =
  | "empty"
  | "ok"
  | "typo"
  | "unsure"
  | "wrong"
  | "wrongFinal"
  | "skip"
  | "reveal"

export interface Slot {
  i: number
  w: Word
  n: string // 归一化目标
  value: string
  state: SlotStateName
  everWrong: boolean
  usedCand: boolean
  firstWrong?: string | null
  cands?: string[] | null
}

export interface SessionLog {
  n: number
  sec: number
  listens: number
  kinds: Record<string, number>
}

export interface Session {
  start: number
  sentStart: number
  slots: number
  good: number
  listens: number
  types: Record<string, number>
  log: SessionLog[]
}

export interface LayerItem {
  k: string
  label: string
}

export interface AttemptPayload {
  lessonId: string
  score: number
  accuracy: number
  wpm?: number
  durationSec: number
  details: {
    slotAccuracy: number
    totalSlots: number
    types: Record<string, number>
    log: SessionLog[]
    tier: number
  }
}

/**
 * 引擎在 finishSentence 里识别「错词」时抛给调用方的载荷。
 *
 * 引擎自身不持有网络 / trpc client —— 通过 loadLesson 的回调层把数据交给
 * 路由那一侧去走 mutation。这样引擎保持纯 JS、可被 engine-smoke 直接跑。
 */
export interface WrongWordRecord {
  lessonId: string
  wordNorm: string
  display: string
  audioUrl: string
  startMs: number
  endMs: number
}
