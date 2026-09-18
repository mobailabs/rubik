/** 整库连播的断点。纯前端，跟练习页的 resume 一样不走后端。 */

export type PlayerProgress = {
  lessonId: string
  time: number
  rate: number
  savedAt: number
}

const KEY = "player:progress"

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* 隐私模式 / 满了就丢掉 */
  }
}

export function readProgress(): PlayerProgress | null {
  const raw = lsGet(KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PlayerProgress>
    if (!v.lessonId || typeof v.time !== "number" || !Number.isFinite(v.time))
      return null
    return {
      lessonId: v.lessonId,
      time: Math.max(0, v.time),
      rate: typeof v.rate === "number" && v.rate > 0 ? v.rate : 1,
      savedAt: typeof v.savedAt === "number" ? v.savedAt : 0,
    }
  } catch {
    return null
  }
}

export function writeProgress(p: Omit<PlayerProgress, "savedAt">) {
  lsSet(
    KEY,
    JSON.stringify({
      lessonId: p.lessonId,
      time: p.time,
      rate: p.rate,
      savedAt: Date.now(),
    }),
  )
}
