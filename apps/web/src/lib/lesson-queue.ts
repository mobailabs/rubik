import type { Lesson, LessonProgress } from "@/hooks/queries/use-lessons"
import { readResumeCheckpoint } from "./engine/usePractice"

/**
 * 「下一课该练哪个」的唯一判定处。
 *
 * 课程列表页（显示进度）和练习结算页（自动续下一课）都用它，否则两处各写一份
 * 排序逻辑，早晚会分叉成「列表说这门，跳过去是另一门」。
 *
 * 排序口径（和需求对齐）：
 *   1. 没练过的排最前 —— 新导入的课应该先被碰一次，否则它会一直躺在列表里；
 *   2. 其次按「上次练习时间」从早到晚 —— 等价于最久没碰的优先，天然轮转，
 *      不会连着几天卡在同一课；
 *   3. 同一天练的，按上传时间倒序收尾（保证顺序稳定，不随查询顺序抖动）。
 *
 * `skipLessonId` 是刚练完的那门：不传的话它会因为「上次练习时间最早」又被选回来。
 */
export function pickNextLesson(
  lessons: Lesson[],
  progressByLesson: Map<string, LessonProgress>,
  skipLessonId?: string,
): Lesson | null {
  const candidates = lessons.filter(
    (l) => l.id !== skipLessonId && l.status === "ready",
  )
  if (!candidates.length) return null

  const lastAt = (l: Lesson) => {
    const p = progressByLesson.get(l.id)
    if (!p?.lastAt) return Number.NEGATIVE_INFINITY // 没练过 → 排最前
    return new Date(p.lastAt).getTime()
  }
  const created = (l: Lesson) =>
    l.createdAt ? new Date(l.createdAt).getTime() : 0

  return (
    candidates.slice().sort((a, b) => {
      const d = lastAt(a) - lastAt(b)
      if (d !== 0) return d
      return created(b) - created(a)
    })[0] ?? null
  )
}

/**
 * 本机断点（localStorage）→ 「第 14/32 句」。
 *
 * 断点只存在本机，所以这个数字**不能**说成"学了 40%"：换台设备、清了浏览器数据
 * 就没了。文案上要把它和「已练 N 轮」（服务端事实）区分开。
 */
export function localCheckpoint(
  lessonId: string,
  sentenceCount: number,
): { idx: number; sentence: number; pct: number } | null {
  const cp = readResumeCheckpoint(lessonId)
  if (!cp || !sentenceCount) return null
  const sentence = Math.min(cp.idx, sentenceCount)
  if (sentence <= 0) return null
  return {
    idx: sentence,
    sentence,
    pct: Math.round((sentence / sentenceCount) * 100),
  }
}

/** 「2 小时前」这类相对时间。超过 30 天就退化成日期，免得"47 天前"读起来费劲。 */
export function relTime(at: Date | string | null | undefined): string {
  if (!at) return ""
  const t = new Date(at).getTime()
  if (!Number.isFinite(t)) return ""
  const sec = Math.max(0, (Date.now() - t) / 1000)
  if (sec < 60) return "刚刚"
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  const days = Math.floor(sec / 86400)
  if (days === 1) return "昨天"
  if (days <= 30) return `${days} 天前`
  return new Date(t).toLocaleDateString()
}

/** 秒 → 「12:40」。和练习页的时钟口径一致。 */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/**
 * 每日剂量（分钟）。
 *
 * 注意口径：这是**练习时长**，不是课程音频的长度。一门 20 秒的音频要听十几遍、
 * 逐词默写、改错、再来一轮，实测一门课要练 10~30 分钟 —— 两者差着几十倍，
 * 别用音频长度去估。这个值是从实际练习记录（attempts.duration_sec）里加的。
 *
 * 和引擎结算卡上的「每日剂量」用的是同一个数（见 usePractice.ts 的 DOSE_SEC），
 * 改一处要改两处；之所以不共享常量，是因为引擎是纯 JS、不引 hooks，而这里要引。
 */
export const DOSE_MIN = 18

/**
 * 今天累计练了多少秒。
 *
 * 数据来自服务端的 `lessons.progress`（每门课的 todaySec 是「今天」的 sum），
 * 所以跨设备一致 —— 在手机上练了 10 分钟，电脑上打开也认。
 */
export function todaySec(progress: LessonProgress[] | undefined): number {
  return (progress ?? []).reduce((n, p) => n + (p.todaySec ?? 0), 0)
}

/**
 * 今天练够剂量了吗。
 *
 * 用来决定「练完一门要不要自动续下一门」，不是用来阻止你继续练 —— 到了线
 * 只是不再自动跳，想练还是点一下就走。判断放在两门课的接缝处，不在中途：
 * 你已经练到一门课的第 3 句时把你掐掉，比让你练完更烦人。
 */
export function doseReached(progress: LessonProgress[] | undefined): boolean {
  return todaySec(progress) >= DOSE_MIN * 60
}
