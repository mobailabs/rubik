import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useLessons, type Lesson } from "@/hooks/queries/use-lessons"
import type { Sentence } from "@/lib/engine/types"
import { pageHead } from "@/lib/site"
import { readProgress, writeProgress } from "@/lib/player-progress"
import {
  PLAY_RATES,
  asSentences,
  formatClock,
  useLessonPlayer,
  type PlayRate,
} from "@/lib/use-lesson-player"
import { Button } from "@repo/ui/components/button"
import { cn } from "@repo/ui/lib/utils"

export const Route = createFileRoute("/dashboard/player/")({
  head: () =>
    pageHead({ title: "Player", path: "/dashboard/player", noIndex: true }),
  component: PlayerPage,
})

function byCreatedAsc(a: Lesson, b: Lesson) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

/** 随机挑一课：返回与 cur 不同的下标；只有一课时返回 0（重播当前）。 */
function randomLessonIdx(cur: number, n: number): number {
  if (n <= 1) return 0
  let t = cur
  while (t === cur) t = Math.floor(Math.random() * n)
  return t
}

function asRate(n: number): PlayRate {
  return PLAY_RATES.find((r) => r === n) ?? 1
}

function CurrentLine({
  sentence,
  wordIdx,
  onWord,
  audioRef,
  playing,
}: {
  sentence: Sentence | undefined
  wordIdx: number
  onWord: (i: number) => void
  audioRef: RefObject<HTMLAudioElement | null>
  playing: boolean
}) {
  const wrapRef = useRef<HTMLParagraphElement>(null)
  const wordRef = useRef<HTMLButtonElement | null>(null)
  const [pill, setPill] = useState({ x: 0, y: 0, w: 0, h: 0, on: false })

  const measure = useCallback(() => {
    const wrap = wrapRef.current
    const el = wordRef.current
    if (!wrap || !el) {
      setPill((p) => ({ ...p, on: false }))
      return
    }
    const a = wrap.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    setPill({
      x: b.left - a.left,
      y: b.top - a.top,
      w: b.width,
      h: b.height,
      on: true,
    })
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure, wordIdx, sentence])

  useEffect(() => {
    const paint = () => {
      const el = wordRef.current
      const w = sentence?.words[wordIdx]
      const t = audioRef.current?.currentTime ?? 0
      if (!el || !w) return
      const span = Math.max(0.05, w.e - w.s)
      const p = Math.min(1, Math.max(0, (t - w.s) / span))
      el.style.setProperty("--p", p.toFixed(4))
    }
    paint()
    if (!playing) return
    let id = 0
    const tick = () => {
      paint()
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, wordIdx, sentence, audioRef])

  if (!sentence) return null
  const words = sentence.words ?? []
  if (!words.length) {
    return (
      <p className="text-xl leading-relaxed tracking-tight">{sentence.text}</p>
    )
  }

  return (
    <p
      ref={wrapRef}
      className="relative text-xl leading-relaxed tracking-tight"
    >
      <span
        aria-hidden
        className={cn(
          "bg-muted pointer-events-none absolute rounded-md",
          "motion-safe:transition-[transform,width,height] motion-safe:duration-200 motion-safe:ease-out",
        )}
        style={{
          transform: `translate(${pill.x}px, ${pill.y}px)`,
          width: pill.w,
          height: pill.h,
          opacity: pill.on ? 1 : 0,
        }}
      />
      {words.map((w, i) => (
        <span key={`${w.s}-${i}`}>
          <button
            ref={i === wordIdx ? wordRef : undefined}
            type="button"
            onClick={() => onWord(i)}
            className={cn(
              "relative z-10 rounded-sm px-0.5",
              i < wordIdx && "text-foreground",
              i > wordIdx && "text-muted-foreground hover:text-foreground",
              i === wordIdx && "bg-clip-text text-transparent",
            )}
            style={
              i === wordIdx
                ? {
                    backgroundImage:
                      "linear-gradient(to right, var(--foreground) calc(var(--p, 0) * 100%), var(--muted-foreground) calc(var(--p, 0) * 100%))",
                  }
                : undefined
            }
          >
            {w.w}
          </button>
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  )
}

function PlayerPage() {
  const { data: lessons, isLoading, error } = useLessons()
  const queue = useMemo(
    () => (lessons ?? []).filter((l) => l.status === "ready").slice().sort(byCreatedAsc),
    [lessons],
  )

  const [lessonId, setLessonId] = useState<string | null>(null)
  const [startAt, setStartAt] = useState(0)
  const [autoplay, setAutoplay] = useState(false)
  const [booted, setBooted] = useState(false)
  const [playlistLoop, setPlaylistLoop] = useState(false)
  const [shuffleLessons, setShuffleLessons] = useState(false)

  useEffect(() => {
    if (!queue.length) {
      setBooted(true)
      return
    }
    if (lessonId && queue.some((l) => l.id === lessonId)) {
      setBooted(true)
      return
    }
    const saved = readProgress()
    const hit = saved && queue.find((l) => l.id === saved.lessonId)
    if (hit && saved) {
      setLessonId(hit.id)
      setStartAt(saved.time)
    } else {
      setLessonId(queue[0]?.id ?? null)
      setStartAt(0)
    }
    setBooted(true)
  }, [queue, lessonId])

  const lesson = queue.find((l) => l.id === lessonId) ?? queue[0]
  const queueIdx = lesson ? queue.findIndex((l) => l.id === lesson.id) : -1
  const sentences = asSentences(lesson?.content)
  const timeRef = useRef(0)
  const rateRef = useRef<PlayRate>(1)

  const lastSave = useRef(0)
  const persist = useCallback((id: string, time: number, rate: PlayRate) => {
    writeProgress({ lessonId: id, time, rate })
  }, [])

  const player = useLessonPlayer(lesson?.audioUrl, sentences, {
    startAt,
    autoplay,
    onProgress: (t) => {
      timeRef.current = t
      const id = lesson?.id
      if (!id) return
      const now = Date.now()
      if (now - lastSave.current < 2000) return
      lastSave.current = now
      persist(id, t, rateRef.current)
    },
    onEnded: () => {
      if (!lesson || !queue.length) return
      const i = queueIdx
      const n = queue.length
      let target = -1
      if (shuffleLessons) {
        // 随机：跳到任意另一课（只有一课时重播当前课）
        target = randomLessonIdx(i, n)
      } else if (i >= 0 && i < n - 1) {
        // 顺序：非最后一课顺延下一课
        target = i + 1
      } else if (playlistLoop) {
        // 最后一课：开启列表循环则回到第一课题重播，否则停住
        target = 0
      }
      if (target < 0) return
      const next = queue[target]
      if (!next) return
      persist(next.id, 0, rateRef.current)
      setLessonId(next.id)
      setStartAt(0)
      setAutoplay(true)
    },
  })

  useEffect(() => {
    const saved = readProgress()
    if (saved) player.setRate(asRate(saved.rate))
    // 只在进页时读一次速率
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  rateRef.current = player.rate
  timeRef.current = player.currentTime

  useEffect(() => {
    const save = () => {
      if (lesson?.id) persist(lesson.id, timeRef.current, rateRef.current)
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") save()
    }
    window.addEventListener("pagehide", save)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      save()
      window.removeEventListener("pagehide", save)
      document.removeEventListener("visibilitychange", onHide)
    }
  }, [lesson?.id, persist])

  const jumpLesson = useCallback(
    (i: number, at: "start" | "end", play: boolean) => {
      const next = queue[i]
      if (!next) return
      const sents = asSentences(next.content)
      const t =
        at === "end" && sents.length ? (sents[sents.length - 1]?.start ?? 0) : 0
      persist(next.id, t, rateRef.current)
      setLessonId(next.id)
      setStartAt(t)
      setAutoplay(play)
    },
    [queue, persist],
  )

  const {
    toggle,
    stepOn,
    loop,
    gapMs,
    setStepMode,
    setLoop,
    setGap,
  } = player
  const prev = useCallback(() => {
    if (player.currentIdx > 0) {
      player.prev()
      return
    }
    if (player.currentTime > 2) {
      player.seekTo(0)
      return
    }
    jumpLesson(queueIdx - 1, "end", player.playing)
  }, [player, queueIdx, jumpLesson])

  const next = useCallback(() => {
    if (player.currentIdx < sentences.length - 1) {
      player.next()
      return
    }
    jumpLesson(queueIdx + 1, "start", player.playing)
  }, [player, sentences.length, queueIdx, jumpLesson])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target
      if (el instanceof HTMLElement) {
        const tag = el.tagName
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          tag === "A"
        )
          return
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault()
        toggle()
      } else if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault()
        prev()
      } else if (e.key === "ArrowRight" || e.key === "k") {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle, prev, next])

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = listRef.current
    const node = root?.querySelector(`#sent-${player.currentIdx}`)
    if (!root || !(node instanceof HTMLElement)) return
    const nodeBox = node.getBoundingClientRect()
    const rootBox = root.getBoundingClientRect()
    if (nodeBox.top >= rootBox.top && nodeBox.bottom <= rootBox.bottom) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const top = root.scrollTop + (nodeBox.top - rootBox.top) - root.clientHeight / 3
    root.scrollTo({ top, behavior: reduce ? "auto" : "smooth" })
  }, [player.currentIdx])

  const setRate = (r: PlayRate) => {
    player.setRate(r)
    rateRef.current = r
    if (lesson?.id) persist(lesson.id, timeRef.current, r)
  }

  if (isLoading || !booted)
    return <p className="text-muted-foreground text-sm">Loading lessons…</p>
  if (error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    )
  if (!queue.length || !lesson)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Player</h1>
        <p className="text-muted-foreground text-sm">
          没有可播放的课程。先到 Practice 上传音频。
        </p>
      </div>
    )

  const max = player.duration > 0 ? player.duration : 0

  return (
    <div className="flex h-[calc(100svh-9rem)] flex-col gap-4 lg:h-[calc(100svh-6rem)]">
      <audio ref={player.audioRef} preload="metadata" />

      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{lesson.title}</h1>
        <Link
          to="/dashboard/practice/$lessonId"
          params={{ lessonId: lesson.id }}
          className="text-muted-foreground shrink-0 text-sm hover:text-foreground"
        >
          去练习
        </Link>
      </div>
      <p className="text-muted-foreground -mt-2 shrink-0 text-xs">
        {queueIdx + 1} / {queue.length}
      </p>

      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={toggle} aria-pressed={player.playing}>
            {player.playing ? "暂停" : "播放"}
          </Button>
          <Button size="sm" variant="ghost" onClick={prev}>
            上一句
          </Button>
          <Button size="sm" variant="ghost" onClick={next}>
            下一句
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={queueIdx <= 0}
            onClick={() => jumpLesson(queueIdx - 1, "start", player.playing)}
          >
            上一课
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!shuffleLessons && queueIdx >= queue.length - 1}
            onClick={() =>
              jumpLesson(
                shuffleLessons
                  ? randomLessonIdx(queueIdx, queue.length)
                  : queueIdx + 1,
                "start",
                player.playing,
              )
            }
          >
            下一课
          </Button>
          <Button
            size="sm"
            variant={playlistLoop ? "secondary" : "ghost"}
            aria-pressed={playlistLoop}
            onClick={() => setPlaylistLoop(!playlistLoop)}
          >
            列表循环
          </Button>
          <Button
            size="sm"
            variant={shuffleLessons ? "secondary" : "ghost"}
            aria-pressed={shuffleLessons}
            onClick={() => setShuffleLessons(!shuffleLessons)}
          >
            随机
          </Button>
          <div className="ml-auto flex items-center gap-1">
            {PLAY_RATES.map((r) => (
              <Button
                key={r}
                size="xs"
                variant={player.rate === r ? "secondary" : "ghost"}
                aria-pressed={player.rate === r}
                onClick={() => setRate(r)}
              >
                {r}×
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={stepOn ? "secondary" : "ghost"}
            aria-pressed={stepOn}
            onClick={() => setStepMode(!stepOn)}
          >
            逐句
          </Button>
          <Button
            size="sm"
            variant={loop ? "secondary" : "ghost"}
            aria-pressed={loop}
            onClick={() => setLoop(!loop)}
          >
            循环
          </Button>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            间隔
            <select
              value={gapMs}
              onChange={(e) => setGap(Number(e.target.value))}
              className="rounded-md border bg-background px-1 py-0.5"
            >
              <option value={0}>0s</option>
              <option value={300}>0.3s</option>
              <option value={500}>0.5s</option>
              <option value={1000}>1s</option>
              <option value={2000}>2s</option>
            </select>
          </label>
        </div>

        <label className="flex items-center gap-3">
          <span className="sr-only">进度</span>
          <input
            type="range"
            min={0}
            max={max || 0}
            step={0.1}
            value={Math.min(player.currentTime, max || 0)}
            disabled={!max}
            onChange={(e) => player.seekTo(Number(e.target.value))}
            className="w-full"
          />
          <span className="text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums">
            {formatClock(player.currentTime)} / {formatClock(player.duration)}
          </span>
        </label>
      </div>

      {sentences.length > 0 && (
        <div className="shrink-0">
          <CurrentLine
            sentence={sentences[player.currentIdx]}
            wordIdx={player.currentWordIdx}
            onWord={(w) => player.playWord(player.currentIdx, w)}
            audioRef={player.audioRef}
            playing={player.playing}
          />
        </div>
      )}

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {!sentences.length ? (
          <p className="text-muted-foreground text-sm">这门课没有句子。</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {sentences.map((s, i) => {
              const active = i === player.currentIdx
              return (
                <li key={`${s.start}-${i}`} id={`sent-${i}`}>
                  <button
                    type="button"
                    onClick={() => player.playSentence(i)}
                    className={cn(
                      "w-full rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <span className="text-muted-foreground mr-3 inline-block w-6 text-xs tabular-nums">
                      {i + 1}
                    </span>
                    {s.text}
                  </button>
                </li>
              )
            })}
          </ol>
        )}

        {queue.length > 1 && (
          <ul className="mt-4 flex flex-col gap-1 border-t pt-4">
            {queue.map((l, i) => {
              const current = l.id === lesson.id
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => jumpLesson(i, "start", player.playing)}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      current
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    {l.title}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
