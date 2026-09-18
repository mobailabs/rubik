import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  useClearLessonWb,
  useGradeWrongWord,
  useMarkWrongWord,
  useRefreshWb,
  useRemoveWrongWord,
  useWbStats,
  useWrongWords,
} from "@/hooks/queries/use-wb"
import { useTRPC } from "@/lib/trpc"
import { isTouchDevice } from "@/lib/engine/device"
import { DOCK_CSS } from "@/lib/dock-css"
import { useVisualViewport, vvStyle } from "@/lib/use-visual-viewport"
import { useSlicePlayer } from "@/lib/use-slice-player"
import { pageHead } from "@/lib/site"

/**
 * 错词本（后端版本）。
 *
 * 数据来源 trpc.wb.list —— 同一个用户同一个词的同一行在 DB 里只占一行
 * （UNIQUE user_id + lesson_id + word_norm），再错只 n++ / last_seen 刷新。
 *
 * 路由分两态：
 *  - 列表：按 lessonId 分组，可展开看词、点词试听。到期词散在多节课时，
 *    顶部给一个「开始今天的复习」把它们排成一个跨课队列一次练完；
 *  - Drill：听 → 默写 → 提交。答对把 due 往后推，看答案或答错明天再来。
 *
 * 桌面端是键盘流（长按空格出命令层），触屏端是底部答题条（见 lib/dock-css.ts）。
 * 两条路径共用同一个引擎状态机，只有输入方式不同。
 */

/**
 * 间隔阶梯，和 apps/api/src/trpc/routers/wb.ts 的 STEP_DAYS 一一对应。
 * 下标 = 连对次数：连对 1 次 → 2 天，2 → 4，3 → 8，4 → 16，5 → 30 且毕业。
 */
const STEP_DAYS = [0, 2, 4, 8, 16, 30]

/**
 * 长按空格出来的命令层。键位和 Practice 的命令层对齐：
 * `e` 慢速重播、`x` 会了（Practice 里 x 就是 known）、`d` 下一个（Practice 里
 * d 就是下一句）。`h` 是固定出口，层里用不上的键也一律当出口。
 */
const LAYER = [
  { k: "e", label: "慢速重播" },
  { k: "a", label: "看答案" },
  { k: "x", label: "会了·出列" },
  { k: "d", label: "下一个" },
  { k: "h", label: "关闭" },
] as const

type WbRow = {
  id: string
  lessonId: string
  lessonTitle: string | null
  wordNorm: string
  display: string
  audioUrl: string
  startMs: number
  endMs: number
  mastered: boolean
  good: number
  n: number
  dueAt: Date | string | null
}

type Scope = "due" | "active" | "mastered"

/** 触屏判定：模块加载时取一次（device.ts 是唯一来源，支持 ?touch=1 覆盖）。 */
const TOUCH = isTouchDevice()

export const Route = createFileRoute("/dashboard/wb")({
  head: () =>
    pageHead({
      title: "错词本",
      path: "/dashboard/wb",
      noIndex: true,
    }),
  component: WB,
})

function WB() {
  const [scope, setScope] = useState<Scope>("due")
  /** 非空 = 正在 Drill。`ids` 是队列里的课（顺序即练习顺序），空数组外的课一律不进。 */
  const [queue, setQueue] = useState<{ ids: string[]; title: string } | null>(
    null,
  )
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const q = useWrongWords(scope)
  const stats = useWbStats()
  const refresh = useRefreshWb()
  const audio = useSlicePlayer()

  // 按课分组，组间按「要练的个数」从多到少 —— 先啃大头
  const groups = useMemo(() => {
    const m = new Map<string, WbRow[]>()
    ;((q.data ?? []) as WbRow[]).forEach((r) => {
      const arr = m.get(r.lessonId) ?? []
      arr.push(r)
      m.set(r.lessonId, arr)
    })
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [q.data])

  const total = q.data?.length ?? 0
  const dueN = stats.data?.due ?? 0
  const canQueue = (scope === "due" || scope === "active") && total > 0

  const toggle = (lid: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(lid)) next.delete(lid)
      else next.add(lid)
      return next
    })

  /* ⚠️ 进 Drill 的提前 return 必须在**全部 hook 之后**。放在中间会让
     hook 数在 进入/退出 Drill 时跳变，React 抛
     "Rendered more hooks than during the previous render." —— 一进复习就白屏。 */
  if (queue) {
    return (
      <Drill
        ids={queue.ids}
        scope={scope}
        title={queue.title}
        onBack={() => {
          setQueue(null)
          // Drill 期间不打点刷新（见 useGradeWrongWord 注释），退出时补一次
          void refresh()
        }}
      />
    )
  }

  return (
    <div className="wb-wrap" data-touch={TOUCH ? "1" : undefined}>
      <style>{CSS + DOCK_CSS}</style>
      <div className="ph">
        <Link to="/dashboard/practice" className="back-link">
          ← 课程
        </Link>
        <h1>错词本 · 专项复习</h1>

        <div className="today">
          <span className="today-n">{dueN}</span>
          <span className="today-l">
            个词今天到期
            {groups.length > 1 && <> · 分布在 {groups.length} 节课</>}
          </span>
        </div>

        <div className="tabs">
          {(
            [
              ["due", "今天"],
              ["active", "待复习"],
              ["mastered", "已会"],
            ] as const
          ).map(([s, label]) => (
            <button
              key={s}
              className={"tab" + (scope === s ? " on" : "")}
              onClick={() => setScope(s)}
            >
              {label}
            </button>
          ))}
        </div>

        {canQueue && (
          <button
            className="btn primary big full"
            onClick={() =>
              setQueue({
                ids: groups.map(([lid]) => lid),
                title: scope === "due" ? "今天到期" : "待复习",
              })
            }
          >
            {scope === "due" ? "开始今天的复习" : "复习全部待复习"}（{total}）
          </button>
        )}

        <div className="sub">
          听 → 默写 → 提交。答对往后推（2·4·8·16·30 天），看答案或答错明天再来，
          连对 5 次毕业。{TOUCH ? "点词可试听。" : ""}
        </div>
        <div className="meta">
          <span>
            今日 +<b>{stats.data?.today ?? 0}</b>
          </span>
          <span>
            总计 <b>{stats.data?.total ?? 0}</b>
          </span>
          <span>
            已会 <b>{stats.data?.mastered ?? 0}</b>
          </span>
        </div>
      </div>

      {q.isLoading && <div className="empty">加载中…</div>}
      {q.error && (
        <div className="empty" role="alert">
          加载失败：{q.error.message}
        </div>
      )}
      {!q.isLoading && groups.length === 0 && !q.error && (
        <div className="empty">
          {scope === "due" &&
            "今天没有到期要复习的词。要么去 Practice 练出新的，要么切「待复习」看看还没到期的。"}
          {scope === "active" &&
            "还没有待复习的错词。先去 Practice 练出「听错/留空/漏尾/多尾」再说。"}
          {scope === "mastered" && "还没有「已会」的词。"}
        </div>
      )}

      <div className="grp">
        {groups.map(([lid, rows]) => (
          <GroupCard
            key={lid}
            title={rows[0]?.lessonTitle ?? lid}
            rows={rows}
            expanded={open.has(lid)}
            onToggle={() => toggle(lid)}
            onDrill={() =>
              setQueue({ ids: [lid], title: rows[0]?.lessonTitle ?? "复习" })
            }
            onPlay={(r) =>
              audio.play({
                audioUrl: r.audioUrl,
                startMs: r.startMs,
                endMs: r.endMs,
              })
            }
            canDrill={scope !== "mastered"}
          />
        ))}
      </div>

      <audio ref={audio.ref} preload="auto" playsInline />
    </div>
  )
}

function GroupCard({
  title,
  rows,
  expanded,
  onToggle,
  onDrill,
  onPlay,
  canDrill,
}: {
  title: string
  rows: WbRow[]
  expanded: boolean
  onToggle: () => void
  onDrill: () => void
  onPlay: (r: WbRow) => void
  canDrill: boolean
}) {
  return (
    <div className="grp-card">
      <div className="grp-head">
        <div className="grp-t">
          <b>{title}</b>
          <span className="grp-n">{rows.length} 个</span>
        </div>
        <div className="grp-acts">
          <button
            className="btn ghost"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? "收起" : "看词"}
          </button>
          {canDrill && (
            <button className="btn primary" onClick={onDrill}>
              练这节课
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="wchips">
          {rows.map((r) => (
            <button key={r.id} className="wchip" onClick={() => onPlay(r)}>
              {r.display}
              {r.good > 0 && <i className="wchip-g">连对 {r.good}</i>}
            </button>
          ))}
          <span className="wchips-hint">
            点词试听。错得多的词会更常出现在练习空位里。
          </span>
        </div>
      )}
    </div>
  )
}

function Drill({
  ids,
  scope,
  title,
  onBack,
}: {
  ids: string[]
  scope: Scope
  title: string
  onBack: () => void
}) {
  // 用和列表同一个 scope 取词 —— 队列里可能有「待复习」里还没到期的词，
  // 只查 due 会把它们漏掉。
  const trpc = useTRPC()
  const q = useQuery(trpc.wb.list.queryOptions({ scope }))
  const words = useMemo(() => {
    const order = new Map(ids.map((id, i) => [id, i]))
    return ((q.data ?? []) as WbRow[])
      .filter((r) => order.has(r.lessonId))
      .sort((a, b) => order.get(a.lessonId)! - order.get(b.lessonId)!)
  }, [q.data, ids])
  return <DrillInner words={words} title={title} onBack={onBack} />
}

function DrillInner({
  words,
  title,
  onBack,
}: {
  words: WbRow[]
  title: string
  onBack: () => void
}) {
  const touch = TOUCH
  /** 可视视口 —— 触屏端整页钉在它上面，键盘弹起时它就是「键盘以上的那半屏」。 */
  const vv = useVisualViewport()
  const audio = useSlicePlayer()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const grade = useGradeWrongWord()
  const mark = useMarkWrongWord()
  const remove = useRemoveWrongWord()
  const clearLesson = useClearLessonWb()
  const [val, setVal] = useState("")
  /** input = 默写中；retry = 已经错过，照着答案打一遍才放行；done = 出结果等下一词。 */
  const [phase, setPhase] = useState<"input" | "retry" | "done">("input")
  /** 本次结果。peek = 看过答案（哪怕最后打对了）；miss = 答错过。 */
  const [result, setResult] = useState<"ok" | "peek" | "miss" | null>(null)
  /** 本词本次按过 `a` 看答案。打对也不推进间隔 —— 否则「听不出 → 看答案 →
   *  抄上 → +2 天」能把一个真不会的词一路推到毕业。 */
  const [peeked, setPeeked] = useState(false)
  const [layerOpen, setLayerOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  /** 破坏性操作的二次确认：删单条 / 清空本课共用一个槽，互斥。 */
  const [pending, setPending] = useState<null | "drop" | "clear">(null)
  const [stats, setStats] = useState({ ok: 0, peek: 0, miss: 0 })
  /** 本次 Drill 已经"消费过"的词 id。错词本 refetch 会让 words 收缩
   *  （刚 master 的那条被过滤掉），但本会话流程不能因此跳过一个未听过的词。
   *  按 id 而不是按下标推进就稳了。 */
  const [done, setDone] = useState<Set<string>>(() => new Set())
  function markDone(id: string) {
    setDone((d) => {
      if (d.has(id)) return d
      const next = new Set(d)
      next.add(id)
      return next
    })
  }

  const remaining = useMemo(
    () => words.filter((w) => !w.mastered && !done.has(w.id)),
    [words, done],
  )
  const finished = remaining.length === 0
  const cur = remaining[0]
  /** 锁定进入 Drill 时的总数（不随 refetch 收缩），给「第 N / 总」和
   *  末尾统计用。useState 的 init 函数只跑一次，words 是 prop 会变。 */
  const [totalOriginal] = useState(
    () => words.filter((w) => !w.mastered).length,
  )

  // 切词：预热 audio src + seek 到切片起点，但**不自动播**（「别擅自放声」）。
  // 依赖用 cur?.id —— cur 对象会随 refetch 换新引用，但同一个词不该重新 cue。
  useEffect(() => {
    if (cur) audio.cue(cur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, audio])

  useEffect(() => {
    if (touch) return
    inputRef.current?.focus()
  }, [cur?.id, touch])

  useEffect(
    () => () => {
      audio.stop()
    },
    [audio],
  )

  function playAgain(rate = 1) {
    if (!cur) return
    audio.play(cur, rate)
  }

  function norm(w: string) {
    return w.toLowerCase().replace(/[^a-z0-9']/g, "")
  }

  /** 收尾：打点 + 出列 + 进 done。`ok=false` 一律明天再来。 */
  function finish(r: "ok" | "peek" | "miss", ok: boolean) {
    if (!cur) return
    setResult(r)
    setPhase("done")
    setStats((s) => ({ ...s, [r]: s[r] + 1 }))
    grade.mutate({ id: cur.id, ok })
    markDone(cur.id)
  }

  function submit() {
    if (!cur || phase === "done") return
    const ok = norm(val) === norm(cur.display)
    if (phase === "retry") {
      // 照打阶段：打对才放行，成绩按 miss 记（前面已经错过一次了）
      if (ok) finish("miss", false)
      return
    }
    if (ok) finish(peeked ? "peek" : "ok", !peeked)
    else {
      setPhase("retry")
      setVal("")
    }
  }

  function next() {
    setVal("")
    setPhase("input")
    setResult(null)
    setPeeked(false)
    setLayerOpen(false)
    setMoreOpen(false)
    // 二次确认必须随词清掉，否则上一个词的"确认删除？"会落到下一个词头上
    setPending(null)
    if (touch) backToDock()
  }

  /** `x` 会了 —— 出列但保留记录（和 Practice 的 x 同义）。 */
  function markKnown() {
    if (!cur) return
    mark.mutate({ id: cur.id, mastered: true })
    markDone(cur.id)
    next()
  }

  /** `d` 下一个 —— 今天不想练这个词，跳过但不改状态。 */
  function skipWord() {
    if (!cur) return
    markDone(cur.id)
    next()
  }

  /** 物理删除（转写错的垃圾词）。破坏性操作，走二次确认。 */
  function dropCur() {
    if (!cur) return
    if (pending !== "drop") {
      setPending("drop")
      return
    }
    setPending(null)
    remove.mutate({ id: cur.id })
    markDone(cur.id)
    next()
  }

  function clearAll() {
    if (!cur) return
    if (pending !== "clear") {
      setPending("clear")
      return
    }
    setPending(null)
    clearLesson.mutate({ lessonId: cur.lessonId }, { onSuccess: onBack })
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault()
      if (phase === "done") next()
      else submit()
    }
  }

  /** 触屏：点 chip 后把焦点还给输入框（按钮会抢焦点 → 软键盘收起）。 */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const backToDock = () => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el && document.activeElement !== el) el.focus()
    })
  }

  /* window 上的监听只绑一次，所以动作全部走 ref —— 直接把函数闭包进去
     会一直拿到首帧的旧 state。 */
  const acts = useRef({
    play: playAgain,
    slow: () => playAgain(0.6),
    peek: () => setPeeked(true),
    known: markKnown,
    skip: skipWord,
  })
  acts.current = {
    play: playAgain,
    slow: () => playAgain(0.6),
    peek: () => setPeeked(true),
    known: markKnown,
    skip: skipWord,
  }

  const spaceHeld = useRef(false)
  const spaceHit = useRef(false)
  useEffect(() => {
    if (touch) return
    const close = () => {
      spaceHeld.current = false
      spaceHit.current = false
      setLayerOpen(false)
    }
    const down = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "Enter") return // 交给 input 的 onKeyDown
      if (e.key === " ") {
        e.preventDefault() // 焦点在 input 上，不拦就把空格打进输入框
        if (e.repeat || spaceHeld.current) return
        spaceHeld.current = true
        spaceHit.current = false
        setLayerOpen(true)
        return
      }
      if (!spaceHeld.current) return
      e.preventDefault()
      if (e.repeat) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : ""
      // 层里用不上的键（含 Esc、方向键）一律当出口 —— 别让用户进得去出不来
      if (!LAYER.some((x) => x.k === k)) {
        close()
        return
      }
      spaceHit.current = true
      if (k === "e") acts.current.slow()
      else if (k === "a") acts.current.peek()
      else if (k === "x") acts.current.known()
      else if (k === "d") acts.current.skip()
      else close() // h
    }
    const up = (e: KeyboardEvent) => {
      if (e.key !== " ") return
      const held = spaceHeld.current
      const hit = spaceHit.current
      close()
      // 轻点（按住期间没碰任何层内键）= 重播。不自动放声，只在此处触发。
      if (held && !hit) acts.current.play()
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", close)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", close)
    }
  }, [touch])

  const okNextLabel =
    cur && cur.good + 1 >= 5
      ? "毕业了"
      : cur
        ? `${STEP_DAYS[cur.good + 1]} 天后再来`
        : ""

  return (
    <div
      className="wb-wrap"
      data-touch={touch ? "1" : undefined}
      data-drill={touch ? "1" : undefined}
      style={touch ? vvStyle(vv) : undefined}
    >
      <style>{CSS + DOCK_CSS}</style>
      {/* 触屏端整页钉在可视视口上，这里是「除答题条以外、可以滚的那块」 */}
      <div className="pbody">
        <div className="ph">
          <button className="back-link" onClick={onBack}>
            ← 返回列表
          </button>
          <h1>{title}</h1>
          <div className="sub">
            {cur?.lessonTitle && <>{cur.lessonTitle} · </>}第{" "}
            <b>{totalOriginal - remaining.length + 1}</b> / {totalOriginal} 个
            {touch && <> · 答对往后推，看答案或答错明天再来</>}
            {!touch && (
              <>
                {" "}
                · 空格 重播 · Enter 提交/下一词 · 长按空格 出命令层（e 慢速 · a
                答案 · x 会了 · d 下一个 · h 关闭）·
                答对往后推，看答案或答错明天再来
              </>
            )}
          </div>

          {cur && (
            <div className="dmeta">
              <span className="dots" aria-label={`连对 ${cur.good} 次`}>
                {[0, 1, 2, 3, 4].map((k) => (
                  <i
                    key={k}
                    className={k < Math.min(cur.good, 5) ? "on" : ""}
                  />
                ))}
              </span>
              <span className="dmeta-l">
                {cur.good >= 5 ? "已毕业" : `再连对 ${5 - cur.good} 次毕业`}
              </span>
              <span className="dmeta-l">
                已错 <b>{cur.n}</b> 次
              </span>
            </div>
          )}
        </div>

        {!finished && cur && (
          <div
            className="drill"
            /* 点按钮不要把焦点从输入框抢走：焦点留在 button 上时，Enter 会重复
             触发那个按钮（"下一词"能连跳两个词），空格也会先激活按钮。 */
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).tagName === "BUTTON") {
                e.preventDefault()
              }
            }}
          >
            {layerOpen && (
              <div className="drill-layer">
                {LAYER.map((it) => (
                  <span className="lk" key={it.k}>
                    <b>{it.k}</b>
                    {it.label}
                  </span>
                ))}
              </div>
            )}

            {!touch && (
              <div className="drill-play">
                <div className="drill-row">
                  <button
                    className="btn primary big"
                    onClick={() => playAgain(1)}
                  >
                    ▶ 播放（空格）
                  </button>
                  <button className="btn ghost" onClick={() => playAgain(0.6)}>
                    慢速 0.6×
                  </button>
                </div>
                <div className="drill-hint">听完默写，按 Enter</div>
              </div>
            )}

            {!touch && (
              <>
                <input
                  ref={inputRef}
                  className={
                    "drill-input " +
                    (result === "ok"
                      ? "ok"
                      : result === "peek" || result === "miss"
                        ? "err"
                        : "")
                  }
                  value={val}
                  placeholder={phase === "retry" ? "照着打一遍" : "（默写）"}
                  onChange={(e) => setVal(e.target.value)}
                  onKeyDown={onKey}
                  readOnly={phase === "done"}
                  autoFocus
                />

                {(peeked || phase === "retry") && phase !== "done" && (
                  <div className="drill-peek">
                    答案：<b>{cur.display}</b>
                    <span className="warn">
                      {phase === "retry"
                        ? "照着打一遍再过（Enter）"
                        : "已提示 · 本次不计入连对"}
                    </span>
                  </div>
                )}

                <div className="drill-side">
                  <button className="btn ghost" onClick={markKnown}>
                    会了（长按空格 x）
                  </button>
                  <button className="btn ghost" onClick={skipWord}>
                    下一个（d）
                  </button>
                  <button className="btn ghost" onClick={dropCur}>
                    {pending === "drop" ? "确认删除？" : "删除这条"}
                  </button>
                  <button className="btn ghost" onClick={clearAll}>
                    {pending === "clear" ? "确认清空？" : "清空本课"}
                  </button>
                </div>

                {phase === "done" && result === "ok" && (
                  <div className="drill-ans ok-ans">
                    对了 ✓ · 已连对 <b>{cur.good + 1}</b> 次 · {okNextLabel}
                    <button className="btn primary" onClick={next}>
                      下一词（Enter）
                    </button>
                  </div>
                )}
                {phase === "done" && result === "peek" && (
                  <div className="drill-ans err-ans">
                    <b>{cur.display}</b> · 看过答案，明天再来
                    <button className="btn primary" onClick={next}>
                      下一词（Enter）
                    </button>
                  </div>
                )}
                {phase === "done" && result === "miss" && (
                  <div className="drill-ans err-ans">
                    <b>{cur.display}</b> · 答错了，明天再来
                    <button className="btn primary" onClick={next}>
                      下一词（Enter）
                    </button>
                  </div>
                )}
                {phase !== "done" && (
                  <button className="btn primary" onClick={submit}>
                    提交（Enter）
                  </button>
                )}
              </>
            )}

            {/* 触屏端结果只留信息，动作按钮在底部答题条上 —— 键盘弹起时它不会被遮住 */}
            {touch && (peeked || phase === "retry") && phase !== "done" && (
              <div className="drill-peek">
                答案：<b>{cur.display}</b>
                <span className="warn">
                  {phase === "retry"
                    ? "照着打一遍再过（点 ✓）"
                    : "已提示 · 本次不计入连对"}
                </span>
              </div>
            )}
            {touch && phase === "done" && (
              <div
                className={
                  "drill-ans " + (result === "ok" ? "ok-ans" : "err-ans")
                }
              >
                {result === "ok" ? (
                  <>
                    对了 ✓ · 已连对 <b>{cur.good + 1}</b> 次 · {okNextLabel}
                  </>
                ) : (
                  <>
                    <b>{cur.display}</b> ·{" "}
                    {result === "peek"
                      ? "看过答案，明天再来"
                      : "答错了，明天再来"}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {finished && (
          <div className="drill-fin">
            <h2>本组复习完</h2>
            <div className="stats">
              <span className="stat-ok">
                一次过 <b>{stats.ok}</b>
              </span>
              <span className="stat-err">
                看了答案 <b>{stats.peek}</b>
              </span>
              <span className="stat-err">
                答错 <b>{stats.miss}</b>
              </span>
              <span>
                共 <b>{totalOriginal}</b> 个
              </span>
            </div>
            <button className="btn primary" onClick={onBack}>
              返回列表
            </button>
          </div>
        )}
      </div>

      {/* ---------- 触屏端底部答题条 ---------- */}
      {touch && !finished && cur && (
        <div className="dock">
          {phase === "done" ? (
            <button className="dock-next" onClick={next}>
              下一词
            </button>
          ) : (
            <>
              <div className="dock-row">
                <input
                  ref={inputRef}
                  className="dock-input"
                  value={val}
                  placeholder={phase === "retry" ? "照着打一遍" : "默写"}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(e) => setVal(e.target.value)}
                  onKeyDown={onKey}
                />
                <button
                  className="dock-ok"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    submit()
                    backToDock()
                  }}
                  aria-label="提交"
                >
                  ✓
                </button>
              </div>
              <div className="dock-chips">
                <button
                  className="chip primary"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    playAgain(1)
                    backToDock()
                  }}
                >
                  ▶ 播放
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    playAgain(0.6)
                    backToDock()
                  }}
                >
                  慢速
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    setPeeked(true)
                    backToDock()
                  }}
                >
                  看答案
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={markKnown}
                >
                  会了
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={skipWord}
                >
                  下一个
                </button>
                <button className="chip" onClick={() => setMoreOpen(true)}>
                  更多
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {moreOpen && (
        <div className="sheet show" onClick={() => setMoreOpen(false)}>
          <div className="sheet-box" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-t">命令</div>
            <div className="sheet-grid">
              <button className="sheet-btn" onClick={dropCur}>
                {pending === "drop" ? "确认删除这条？" : "删除这条"}
              </button>
              <button className="sheet-btn" onClick={clearAll}>
                {pending === "clear" ? "确认清空本课？" : "清空本课"}
              </button>
            </div>
            <button className="sheet-close" onClick={() => setMoreOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}

      <audio ref={audio.ref} preload="auto" playsInline />
    </div>
  )
}

const CSS = `
.wb-wrap{
  max-width:960px;margin:0 auto;padding:28px 34px 34px;
  color:var(--foreground);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;
  background:var(--card);border:1px solid var(--border);border-radius:18px;
  box-shadow:0 12px 36px -22px rgba(0,0,0,.18);
}
.wb-wrap h1{font-size:18px;font-weight:650;margin:8px 0 8px;letter-spacing:.02em}
.back-link{background:none;border:none;cursor:pointer;color:var(--muted-foreground);font-size:12.5px;padding:0;text-decoration:none;font-family:inherit}
.back-link:hover{color:var(--primary)}
.ph .sub{color:var(--muted-foreground);font-size:13px;margin-bottom:14px;line-height:1.7}
.ph .meta{display:flex;gap:18px;font-size:13px;color:var(--muted-foreground);margin-bottom:14px;flex-wrap:wrap}
.ph .meta b{color:var(--foreground);font-weight:600}
.ph .tabs{display:flex;gap:6px;margin-bottom:16px}
.tab{background:var(--muted);color:var(--muted-foreground);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit}
.tab.on{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
.empty{color:var(--muted-foreground);padding:36px 0;text-align:center;font-size:14px}
/* 到期总数：这一页最重要的一句话，放最上面给足字号 */
.today{display:flex;align-items:baseline;gap:10px;margin:6px 0 14px}
.today-n{font-size:34px;font-weight:650;line-height:1.05;font-variant-numeric:tabular-nums}
.today-l{font-size:13px;color:var(--muted-foreground)}
.grp{display:flex;flex-direction:column;gap:10px}
.grp-card{padding:14px 18px;background:var(--muted);border:1px solid var(--border);border-radius:12px}
.grp-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.grp-t{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
/* 课程名可能很长（默认是录音文件名）。窄屏上必须省略号收尾 —— 否则文字
   会溢出到右侧按钮底下，和「看词/练这节课」叠在一起（390px 上实测到）。 */
.grp-t b{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-t b{font-size:15px}
.grp-n{color:var(--muted-foreground);font-size:12.5px}
.grp-acts{display:flex;gap:8px;flex:none}
.wchips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.wchip{display:inline-flex;align-items:center;gap:6px;background:var(--background);border:1px solid var(--border);border-radius:8px;padding:5px 11px;font-size:13px;color:var(--foreground);font-family:inherit;cursor:pointer}
.wchip:active{border-color:var(--primary);color:var(--primary)}
.wchip-g{font-style:normal;font-size:11px;color:var(--ok)}
.wchips-hint{width:100%;color:var(--muted-foreground);font-size:12px;line-height:1.7}
.btn.primary{background:var(--primary);color:var(--primary-foreground);border:none;border-radius:9px;padding:10px 18px;font-weight:600;cursor:pointer;transition:filter .15s;font-family:inherit}
.btn.primary:hover:not(:disabled){filter:brightness(1.12)}
.btn.primary:disabled{opacity:.5;cursor:not-allowed}
.btn.primary.big{padding:14px 26px;font-size:16px}
.btn.primary.full{display:block;width:100%;margin-bottom:12px}
.btn.ghost{background:transparent;color:var(--muted-foreground);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
.btn.ghost:hover{color:var(--foreground)}
/* Drill */
.dmeta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}
.dots{display:inline-flex;gap:4px}
.dots i{width:8px;height:8px;border-radius:50%;background:var(--border);display:inline-block}
.dots i.on{background:var(--ok)}
.dmeta-l{font-size:12.5px;color:var(--muted-foreground)}
.dmeta-l b{color:var(--foreground);font-weight:600}
.drill{display:flex;flex-direction:column;align-items:center;gap:16px;padding:18px 0 8px}
.drill-play{display:flex;flex-direction:column;align-items:center;gap:8px}
.drill-row{display:flex;gap:8px;align-items:center}
.drill-hint{color:var(--muted-foreground);font-size:12.5px}
.drill-input{font:18px system-ui,-apple-system,"PingFang SC",sans-serif;padding:12px 18px;border:1px solid var(--input);border-bottom:2px solid var(--border);border-radius:10px;background:var(--background);color:var(--foreground);text-align:center;outline:none;width:min(420px,80vw);transition:border-color .15s,box-shadow .15s}
.drill-input:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in oklab,var(--primary) 18%,transparent)}
.drill-input.ok{color:#15803d;border-color:#bbf7d0;background:#f0fdf4}
.drill-input.err{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
.drill-side{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.drill-layer{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;padding:10px 14px;background:var(--muted);border:1px solid var(--border);border-radius:10px}
.lk{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted-foreground)}
.lk b{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border-radius:5px;background:var(--background);border:1px solid var(--border);color:var(--foreground);font-size:12px;font-weight:600}
.drill-peek{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 18px;background:var(--muted);border:1px solid var(--border);border-radius:10px;font-size:14px;text-align:center}
.drill-peek b{font-weight:600}
.drill-peek .warn{font-size:12.5px;color:var(--muted-foreground)}
.drill-ans{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 18px;background:var(--muted);border:1px solid var(--border);border-radius:10px;font-size:14px;text-align:center;min-width:min(420px,80vw)}
.drill-ans.ok-ans{color:#15803d}
.drill-ans.err-ans{color:#b91c1c}
.drill-fin{display:flex;flex-direction:column;gap:14px;padding:22px 24px;background:var(--muted);border:1px solid var(--border);border-radius:14px;align-items:flex-start}
.drill-fin h2{font-size:12px;margin:0;color:var(--muted-foreground);letter-spacing:.14em;font-weight:600}
.drill-fin .stats{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted-foreground)}
.drill-fin .stats b{font-weight:600;color:var(--foreground)}
.drill-fin .stat-ok{color:#15803d}
.drill-fin .stat-err{color:#b91c1c}
.dark .drill-input.ok{color:#4ade80;border-color:#2c5c38;background:#132018}
.dark .drill-input.err{color:#f0a2a2;border-color:#5c2f34;background:#201314}
.dark .drill-ans.ok-ans{color:#4ade80}
.dark .drill-ans.err-ans{color:#f0a2a2}
.dark .drill-fin .stat-ok{color:#4ade80}
.dark .drill-fin .stat-err{color:#f0a2a2}
/* ---------- 触屏端布局（答题条样式在 lib/dock-css.ts） ---------- */
.wb-wrap[data-touch="1"]{max-width:none;background:transparent;border:none;box-shadow:none;border-radius:0;padding:14px 14px calc(170px + env(safe-area-inset-bottom,0px))}
/* Drill 和练习页同一套：整页钉在**可视视口**上（键盘只压缩可视视口，
   不压缩布局视口），内部 flex 列 = 词卡靠 margin-top:auto 贴到答题条上方 + 贴键盘上沿的答题条。
   背景必须不透明：这一层盖住了 app 外壳的顶栏，透明的话顶栏会从底下透上来。
   只有 Drill 走这套 —— 列表页是要能滚的常规页，不该被钉住。 */
.wb-wrap[data-touch="1"][data-drill="1"]{
  position:fixed;left:0;right:0;top:0;margin:0;padding:0;
  height:var(--vvh,100vh);transform:translateY(var(--vvo,0px));
  display:flex;flex-direction:column;overflow:hidden;background:var(--background);
}
.wb-wrap[data-touch="1"][data-drill="1"] .pbody{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;padding:8px 14px 14px}
/* 词卡永远贴着答题条上方：margin-top:auto 吃掉多余空白；空间不够时先压 .ph
   （从底下裁，裁到的是课程名/连对进度，返回按钮和标题在最上面） */
.wb-wrap[data-touch="1"][data-drill="1"] .pbody>.drill{margin-top:auto;flex:0 0 auto}
.wb-wrap[data-touch="1"][data-drill="1"] .pbody>.ph{flex:0 1 auto;min-height:48px;overflow:hidden}
/* 答题条不再是 fixed：它是这条 flex 列的最后一行，键盘一弹自动跟着上移。
   flex:0 0 auto —— 词卡内容多时宁可让上面那块溢出滚动，也别把答题条挤扁。 */
.wb-wrap[data-touch="1"][data-drill="1"] .dock{position:static;flex:0 0 auto}
.wb-wrap[data-touch="1"] h1{font-size:16px;margin:6px 0 8px}
/* 返回链接在手机上也是要点的按钮，别只有 15px 高 */
.wb-wrap[data-touch="1"] .back-link{display:inline-flex;align-items:center;min-height:44px;padding-right:10px}
.wb-wrap[data-touch="1"] .today{margin:4px 0 12px}
.wb-wrap[data-touch="1"] .today-n{font-size:30px}
.wb-wrap[data-touch="1"] .tabs{gap:4px;background:var(--muted);border-radius:10px;padding:3px;margin-bottom:12px}
.wb-wrap[data-touch="1"] .tab{flex:1;height:44px;border:none;background:none;border-radius:8px;font-size:13px}
.wb-wrap[data-touch="1"] .tab.on{background:var(--card);color:var(--foreground);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.wb-wrap[data-touch="1"] .btn.primary{min-height:46px;padding:12px 18px}
.wb-wrap[data-touch="1"] .btn.ghost{min-height:44px;padding:0 14px;font-size:13px}
.wb-wrap[data-touch="1"] .grp-card{padding:12px 14px}
.wb-wrap[data-touch="1"] .wchip{min-height:44px;padding:0 12px}
.wb-wrap[data-touch="1"] .drill{padding:8px 0 4px}
.wb-wrap[data-touch="1"] .drill-peek{min-width:0;width:100%;box-sizing:border-box;font-size:15px}
.wb-wrap[data-touch="1"] .drill-ans{min-width:0;width:100%;box-sizing:border-box;font-size:15px}
.wb-wrap[data-touch="1"] .drill-fin{padding:16px}
.wb-wrap[data-touch="1"] .drill-fin .btn.primary{width:100%}
`
