import { useCallback, useEffect, useRef, useState } from "react"
import type { Sentence, Word } from "@/lib/engine/types"

export const PLAY_RATES = [0.75, 1, 1.25] as const
export type PlayRate = (typeof PLAY_RATES)[number]

export function asSentences(content: unknown): Sentence[] {
  if (Array.isArray(content)) return content as Sentence[]
  if (
    content &&
    typeof content === "object" &&
    Array.isArray((content as { sentences?: unknown }).sentences)
  ) {
    return (content as { sentences: Sentence[] }).sentences
  }
  return []
}

function sentenceAt(sentences: Sentence[], t: number): number {
  if (!sentences.length) return 0
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]
    if (s && t >= s.start) return i
  }
  return 0
}

function wordAt(words: Word[], t: number): number {
  if (!words.length) return -1
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w && t >= w.s && t < w.e) return i
  }
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]
    if (w && t >= w.s) return i
  }
  return 0
}

function syncCursor(
  sentences: Sentence[],
  t: number,
): { sentence: number; word: number } {
  const sentence = sentenceAt(sentences, t)
  const words = sentences[sentence]?.words ?? []
  return { sentence, word: wordAt(words, t) }
}

function shuffleExcept(n: number, keep: number): number[] {
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => i !== keep)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return keep >= 0 && keep < n ? [keep, ...rest] : rest
}

export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

export type LessonPlayerOpts = {
  /** 换 src 时 seek 到这里（断点续播）。只在 audioUrl 变化时读一次。 */
  startAt?: number
  autoplay?: boolean
  onEnded?: () => void
  onProgress?: (time: number) => void
}

/**
 * 整课连续播放。timeupdate 对当前句，点某句 seek 到那句的 start。
 * 切片播放仍走 `useSlicePlayer`（错词本 / 练习挖空）。
 *
 * 逐句模式（stepOn）：从当前句起，按 order 逐句播放；到句尾刹车 → 等 gap → 放下一句。
 *   - shuffle：打乱 order（当前句保留在首位，其余随机）。
 *   - loop：放完最后一句回到 order[0]；否则停在最后一句。
 *   - gapMs：句间停顿。
 * 关闭逐句模式时，行为与原来一致（整课连续播，点句即从此句连播到底）。
 */
export function useLessonPlayer(
  audioUrl: string | undefined,
  sentences: Sentence[],
  opts: LessonPlayerOpts = {},
) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const sentencesRef = useRef(sentences)
  const idxRef = useRef(0)
  const optsRef = useRef(opts)
  sentencesRef.current = sentences
  optsRef.current = opts

  // 逐句模式状态（放 ref 里供事件回调同步读取，避免闭包拿到旧值）
  const stepRef = useRef({ on: false, shuffle: false, loop: false, gap: 500 })
  const orderRef = useRef<number[]>([])
  const orderPosRef = useRef(0)
  const boundaryRef = useRef<number | null>(null)
  const gapTimerRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRateState] = useState<PlayRate>(1)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [currentWordIdx, setCurrentWordIdx] = useState(-1)
  const wordRef = useRef(-1)

  const [stepOn, setStepOnState] = useState(false)
  const [shuffle, setShuffleState] = useState(false)
  const [loop, setLoopState] = useState(false)
  const [gapMs, setGapState] = useState(500)
  const [stepActive, setStepActive] = useState(false)

  const clearGap = useCallback(() => {
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current)
      gapTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (!a || !audioUrl) return
    const startAt = optsRef.current.startAt ?? 0
    const autoplay = optsRef.current.autoplay ?? false
    a.src = audioUrl
    setPlaying(false)
    setCurrentTime(startAt)
    const startCur = syncCursor(sentencesRef.current, startAt)
    setCurrentIdx(startCur.sentence)
    idxRef.current = startCur.sentence
    wordRef.current = startCur.word
    setCurrentWordIdx(startCur.word)

    let kicked = false
    const applyStart = () => {
      const dur = Number.isFinite(a.duration) ? a.duration : 0
      if (dur) setDuration(dur)
      if (kicked || a.readyState < 1) return
      kicked = true
      if (startAt > 0) {
        a.currentTime = dur > 0 ? Math.min(startAt, Math.max(0, dur - 0.05)) : startAt
        setCurrentTime(a.currentTime)
        const cur = syncCursor(sentencesRef.current, a.currentTime)
        idxRef.current = cur.sentence
        setCurrentIdx(cur.sentence)
        wordRef.current = cur.word
        setCurrentWordIdx(cur.word)
      }
      if (autoplay) void a.play().catch(() => {})
    }

    const applyCursor = (t: number) => {
      const cur = syncCursor(sentencesRef.current, t)
      idxRef.current = cur.sentence
      setCurrentIdx(cur.sentence)
      if (cur.word !== wordRef.current) {
        wordRef.current = cur.word
        setCurrentWordIdx(cur.word)
      }
    }

    const onTime = () => {
      // 逐句模式：到句尾刹车，等 gap 后放下一句
      if (stepRef.current.on && boundaryRef.current != null && a.currentTime >= boundaryRef.current - 0.03) {
        a.pause()
        boundaryRef.current = null
        const pos = orderPosRef.current
        const n = orderRef.current.length
        if (!n) return
        const isLast = pos >= n - 1
        if (isLast && !stepRef.current.loop) {
          setStepActive(false)
          return
        }
        const nextPos = isLast ? 0 : pos + 1
        const nextIdx = orderRef.current[nextPos]
        orderPosRef.current = nextPos
        clearGap()
        gapTimerRef.current = window.setTimeout(() => {
          playSentenceAt(nextIdx)
        }, Math.max(0, stepRef.current.gap))
        return
      }
      setCurrentTime(a.currentTime)
      applyCursor(a.currentTime)
      optsRef.current.onProgress?.(a.currentTime)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      // 逐句模式由 stepping 自己控进度，不要触发整课/换课
      if (stepRef.current.on) {
        setPlaying(false)
        return
      }
      setPlaying(false)
      if (Number.isFinite(a.duration)) setCurrentTime(a.duration)
      optsRef.current.onEnded?.()
    }

    a.addEventListener("timeupdate", onTime)
    a.addEventListener("durationchange", applyStart)
    a.addEventListener("loadedmetadata", applyStart)
    a.addEventListener("play", onPlay)
    a.addEventListener("pause", onPause)
    a.addEventListener("ended", onEnded)
    if (a.readyState >= 1) applyStart()
    return () => {
      a.pause()
      a.removeEventListener("timeupdate", onTime)
      a.removeEventListener("durationchange", applyStart)
      a.removeEventListener("loadedmetadata", applyStart)
      a.removeEventListener("play", onPlay)
      a.removeEventListener("pause", onPause)
      a.removeEventListener("ended", onEnded)
      clearGap()
      boundaryRef.current = null
    }
  }, [audioUrl, clearGap])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate])

  useEffect(() => {
    if (!playing) return
    let id = 0
    const tick = () => {
      const a = audioRef.current
      if (a) {
        const cur = syncCursor(sentencesRef.current, a.currentTime)
        if (cur.sentence !== idxRef.current) {
          idxRef.current = cur.sentence
          setCurrentIdx(cur.sentence)
        }
        if (cur.word !== wordRef.current) {
          wordRef.current = cur.word
          setCurrentWordIdx(cur.word)
        }
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing])

  // 逐句模式开关：开启时从当前句起按 order 步进
  useEffect(() => {
    stepRef.current.on = stepOn
    if (!stepOn) {
      setStepActive(false)
      clearGap()
      boundaryRef.current = null
      return
    }
    const n = sentencesRef.current.length
    if (!n) return
    if (!orderRef.current.length) {
      orderRef.current = stepRef.current.shuffle
        ? shuffleExcept(n, idxRef.current)
        : Array.from({ length: n }, (_, i) => i)
    }
    setStepActive(true)
    playSentence(idxRef.current)
    // playSentence 依赖下方定义，放在此处引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepOn, clearGap])

  const seekTo = useCallback((t: number) => {
    const a = audioRef.current
    if (!a) return
    const next = Math.max(0, t)
    a.currentTime = next
    setCurrentTime(next)
    const cur = syncCursor(sentencesRef.current, next)
    idxRef.current = cur.sentence
    setCurrentIdx(cur.sentence)
    wordRef.current = cur.word
    setCurrentWordIdx(cur.word)
  }, [])

  // 放第 idx 句；逐句模式下设置句尾 boundary，否则整课连播
  const playSentenceAt = useCallback(
    (idx: number) => {
      const list = sentencesRef.current
      const a = audioRef.current
      if (!list.length || !a || idx < 0 || idx >= list.length) return
      const s = list[idx]
      a.pause()
      a.currentTime = s.start
      setCurrentIdx(idx)
      const cur = syncCursor(list, s.start)
      wordRef.current = cur.word
      setCurrentWordIdx(cur.word)
      const nextStart = list[idx + 1]?.start
      const boundary =
        nextStart != null
          ? nextStart
          : Number.isFinite(a.duration) && a.duration > 0
            ? a.duration
            : s.start + 4
      boundaryRef.current = stepRef.current.on ? boundary : null
      clearGap()
      a.play().catch(() => {})
    },
    [setCurrentIdx, setCurrentWordIdx, clearGap],
  )

  const goSentence = useCallback(
    (i: number) => {
      const list = sentencesRef.current
      if (!list.length) return
      const idx = Math.max(0, Math.min(i, list.length - 1))
      const s = list[idx]
      if (!s) return
      seekTo(s.start)
    },
    [seekTo],
  )

  // 点句：逐句模式对齐 order 位置并继续步进；否则从此句连播到底
  const playSentence = useCallback(
    (i: number) => {
      const list = sentencesRef.current
      if (!list.length) return
      const idx = Math.max(0, Math.min(i, list.length - 1))
      if (stepRef.current.on) {
        const p = orderRef.current.indexOf(idx)
        if (p >= 0) orderPosRef.current = p
        setStepActive(true)
      }
      playSentenceAt(idx)
    },
    [playSentenceAt],
  )

  const playWord = useCallback(
    (sentenceIdx: number, wordIdx: number) => {
      const w = sentencesRef.current[sentenceIdx]?.words[wordIdx]
      if (!w) return
      seekTo(w.s)
      void audioRef.current?.play().catch(() => {})
    },
    [seekTo],
  )

  const toggle = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (stepRef.current.on) {
      if (a.paused) {
        setStepActive(true)
        playSentence(idxRef.current)
      } else {
        a.pause()
        clearGap()
        boundaryRef.current = null
        setStepActive(false)
      }
      return
    }
    if (a.paused) void a.play().catch(() => {})
    else a.pause()
  }, [playSentence, clearGap])

  const next = useCallback(() => goSentence(idxRef.current + 1), [goSentence])
  const prev = useCallback(() => goSentence(idxRef.current - 1), [goSentence])

  const setRate = useCallback((r: PlayRate) => setRateState(r), [])

  const setStepMode = useCallback((on: boolean) => setStepOnState(on), [])
  const setShuffle = useCallback((s: boolean) => {
    setShuffleState(s)
    stepRef.current.shuffle = s
    const n = sentencesRef.current.length
    if (!n) return
    orderRef.current = s ? shuffleExcept(n, idxRef.current) : Array.from({ length: n }, (_, i) => i)
    orderPosRef.current = orderRef.current.indexOf(idxRef.current)
  }, [])
  const setLoop = useCallback((l: boolean) => {
    setLoopState(l)
    stepRef.current.loop = l
  }, [])
  const setGap = useCallback((g: number) => {
    setGapState(g)
    stepRef.current.gap = g
  }, [])

  return {
    audioRef,
    playing,
    currentTime,
    duration,
    rate,
    setRate,
    currentIdx,
    currentWordIdx,
    seekTo,
    goSentence,
    playSentence,
    playWord,
    toggle,
    next,
    prev,
    // 逐句模式
    stepOn,
    shuffle,
    loop,
    gapMs,
    stepActive,
    setStepMode,
    setShuffle,
    setLoop,
    setGap,
  }
}
