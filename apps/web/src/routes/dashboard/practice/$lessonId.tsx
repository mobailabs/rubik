import { useCallback, useEffect, useRef, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useLesson, useLessonProgress, useLessons } from "@/hooks/queries/use-lessons"
import { useSaveAttempt } from "@/hooks/queries/use-attempts"
import { isTouchDevice } from "@/lib/engine/device"
import { usePractice } from "@/lib/engine/usePractice"
import { DOCK_CSS } from "@/lib/dock-css"
import { useVisualViewport, vvStyle } from "@/lib/use-visual-viewport"
import { useTRPC } from "@/lib/trpc"
import { pickNextLesson, DOSE_MIN, doseReached, mmss, todaySec } from "@/lib/lesson-queue"
import type { LessonContent, Slot, WrongWordRecord } from "@/lib/engine/types"

export const Route = createFileRoute("/dashboard/practice/$lessonId")({
  component: Practice,
})

/**
 * 练完到自动进下一课之间的秒数。
 *
 * 8 秒是"够看清成绩、来不及烦躁"的折中：结算卡上要读的是正确率和最常错的那类，
 * 扫一眼大约 5 秒。少于 5 秒会在用户正读的时候被带走；多于 12 秒则等着比手动点还慢。
 * 期间有「立即进入」和「取消」，所以这个值只影响默认体验，不构成强制。
 */
const AUTO_NEXT_SEC = 8

function slotClass(sl: Slot, active: boolean): string {
  return ["slot", sl.state, active ? "active" : ""].filter(Boolean).join(" ")
}
function slotPlaceholder(sl: Slot): string {
  const len = sl.n.length
  if ((sl.state === "wrong" || sl.everWrong) && len >= 3)
    return sl.n.slice(0, 1) + "_".repeat(Math.min(len, 10) - 1)
  return "_".repeat(Math.min(len, 10))
}

function Practice() {
  /* React 编译器会把 engine.gateOpen 这类"可变 ref 对象上的字段读取"当成
     不变的依赖 memo 起来 —— engine 引用永远不变，于是起播门点了解锁、
     gateOpen 已经是 false，JSX 里读到的还是缓存的 true，门永远关不上。
     引擎整体是"改自己字段 + bump()"的命令式模式，这个组件直接退出编译器。 */
  "use no memo"
  const { lessonId } = Route.useParams()
  const { data, isLoading } = useLesson(lessonId)
  const saveAttempt = useSaveAttempt()
  const trpc = useTRPC()
  const qc = useQueryClient()
  const recordWrongWord = useMutation(trpc.wb.record.mutationOptions())
  // 拉活跃 wb 的归一化词集 → 引擎按「我曾经错过」加权填空位置。
  const knownWrongQ = useQuery(trpc.wb.list.queryOptions({ scope: "active" }))
  const loadedRef = useRef<string | null>(null)
  /** 触屏判定只在挂载时取一次（device.ts 是唯一来源，支持 ?touch=1 覆盖）。 */
  const [touch] = useState(isTouchDevice)
  /** 可视视口 —— 触屏端整页钉在它上面，键盘弹起时它就是"键盘以上的那半屏"。 */
  const vv = useVisualViewport()
  const wbActive = knownWrongQ.data?.length ?? 0

  /* 手动加入错词本的即时反馈：滑一下就消失，不占版面。 */
  const [wbToast, setWbToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const toast = useCallback((t: string) => {
    setWbToast(t)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setWbToast(null), 1800)
  }, [])
  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  /**
   * 引擎抛「这一词错了」的回调 —— 写 DB 一行。
   *
   * `manual`（用户按 a 主动加）走 unmaster：把已标「会了」的行拉回活跃，
   * 并给一句提示；失败也提示，因为这次是用户盯着看的动作。
   * `auto`（结算自动记）失败静默吞：再错一次同词还会再调，下一次就补上。
   */
  const handleWrongWord = useCallback(
    (row: WrongWordRecord, source?: "auto" | "manual") => {
      const manual = source === "manual"
      recordWrongWord.mutate(
        { ...row, unmaster: manual },
        {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: trpc.wb.list.queryKey() })
            qc.invalidateQueries({ queryKey: trpc.wb.stats.queryKey() })
            if (manual) toast(`已加入错词本：${row.display}`)
          },
          onError: () => {
            if (manual) toast("加入失败，稍后再试")
          },
        },
      )
    },
    [recordWrongWord, qc, trpc, toast],
  )

  const { engine, audioRef, ver } = usePractice(
    (p) =>
      saveAttempt.mutate(p, {
        onSuccess: () =>
          qc.invalidateQueries({ queryKey: trpc.attempts.list.queryKey() }),
      }),
    handleWrongWord,
  )

  /* ---------- 练完自动进下一课 ---------- */
  const navigate = useNavigate()
  const lessonsQ = useLessons()
  const progressQ = useLessonProgress()

  /**
   * 下一课的判定要在**结算那一刻定格**。
   *
   * 不能每帧重算：结算后 `attempts` 会失效重取，`progress` 里本课的 `lastAt`
   * 变成"刚刚"，排序结果就变了 —— 用户会看到倒计时上的课名自己换掉。
   * 所以结算时快照一次，之后只走倒计时。
   *
   * 剂量同理，也在这一刻定格：本轮刚存进库，今天的累计时长会跳一下（实测一门课
   * 练十几分钟，够跨过 18 分钟的线）。定格后即使 `progress` 再刷新也不改判 ——
   * 「刚练完这轮才算够」和「练之前就够」是两回事，后者才是停下来的理由。
   */
  const [nextLesson, setNextLesson] = useState<{ id: string; title: string } | null>(
    null,
  )
  const [countdown, setCountdown] = useState(0)
  /** 结算那一刻「今天是否已练够」。够 = 不自动续，只在卡上给提醒。 */
  const [doseDone, setDoseDone] = useState(false)
  const over = engine.over
  /** 用户点过「取消」/「立即进入」/「再练一门」后不再自动跳（含切走再切回来的情况）。 */
  const autoStopRef = useRef(false)

  useEffect(() => {
    if (!over || autoStopRef.current) return
    const lessons = lessonsQ.data
    if (!lessons) return

    /*
      ⚠️ 这里的 `progressQ.data` 是**结算前**的值：attempts 刚存进去，
      invalidate 触发的重取还没回来。所以刚练完的那一轮还没算进 todaySec。
      影响：今天差一点到线时，这一次会判成"没够"、起倒计时。

      不靠"等重取"来救 —— 那要把判定挪进回调链、再和取消按钮抢状态。改成
      双保险：这里用旧值起倒计时（乐观），下面的 gotoNext 在**真正跳的前一刻**
      再判一次，用那时已经刷新的值。跳转是唯一有副作用的动作，把闸门放在那里
      最可靠。
    */
    const nxt = pickNextLesson(
      lessons,
      new Map((progressQ.data ?? []).map((p) => [p.lessonId, p])),
      lessonId,
    )
    if (!nxt) return
    setNextLesson({ id: nxt.id, title: nxt.title })
    setCountdown(doseReached(progressQ.data) ? 0 : AUTO_NEXT_SEC)
  }, [over, lessonsQ.data, progressQ.data, lessonId])

  /*
    真正的闸门：跳之前用最新数据判一次剂量。

    `doseDoneRef` 存判定结果给界面用，但**不参与**"能不能跳"的决定 —— 界面
    读 state、跳转读 ref，两者可能差一帧；跳转只认当下这一判。
  */
  const doseReachedNow = useCallback(
    () => doseReached(progressQ.data),
    [progressQ.data],
  )

  // 倒计时。用 setTimeout 每秒一跳而不是 setInterval：卸载 / 取消后剩下的
  // 那次 timeout 一定被下面的 cleanup 清掉。
  useEffect(() => {
    if (!nextLesson || countdown <= 0) return
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [nextLesson, countdown])

  const gotoNext = useCallback(
    (opts?: { auto?: boolean }) => {
      if (!nextLesson) return
      // 自动跳（倒计时到点）才受剂量管；用户点「立即进入」「再练一门」一律放行
      if (opts?.auto && doseReachedNow()) {
        setDoseDone(true)
        setCountdown(0)
        return
      }
      autoStopRef.current = true
      setCountdown(0)
      void navigate({
        to: "/dashboard/practice/$lessonId",
        params: { lessonId: nextLesson.id },
        // replace：练完一串课按返回时，不该一课一课倒着退回去
        replace: true,
      })
    },
    [nextLesson, navigate, doseReachedNow],
  )

  // 倒计时到点 → 自动跳（受剂量管）
  useEffect(() => {
    if (!nextLesson || countdown > 0 || autoStopRef.current) return
    gotoNext({ auto: true })
  }, [nextLesson, countdown, gotoNext])

  // 剂量状态跟着数据走：够不够是服务端说了算，每次 progressQ 刷新都重判一次，
  // 界面才不会停在错误的判断上。
  useEffect(() => {
    if (!over) return
    setDoseDone(doseReached(progressQ.data))
  }, [over, progressQ.data])

  // 换课时把上一课的倒计时残留清掉（同一个组件实例被复用，state 不会自己重置）
  useEffect(() => {
    autoStopRef.current = false
    setNextLesson(null)
    setCountdown(0)
    setDoseDone(false)
  }, [lessonId])

  useEffect(() => {
    if (data && loadedRef.current !== data.id) {
      const knownWrong = new Set<string>(
        (knownWrongQ.data ?? []).map((r) => r.wordNorm),
      )
      const checkpoint = engine.loadCheckpoint(data.id)
      engine.loadLesson(
        data.content as unknown as LessonContent,
        data.audioUrl,
        data.id,
        data.title,
        knownWrong,
      )
      // 断点续练：上次离开在哪句，回来就停在哪句（gotoIdx 自带越界保护）
      if (checkpoint && checkpoint.idx > 0) engine.gotoIdx(checkpoint.idx)
      loadedRef.current = data.id
    }
  }, [data, engine, knownWrongQ.data])

  // 切出去（关标签页 / 切 App / 站内跳走）时存一次当前句，回来能续
  useEffect(() => {
    const save = () => engine.saveCheckpoint()
    const onVis = () => {
      if (document.visibilityState === "hidden") save()
    }
    window.addEventListener("beforeunload", save)
    document.addEventListener("visibilitychange", onVis)
    return () => {
      save()
      window.removeEventListener("beforeunload", save)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [engine])

  const s = engine.cur()
  const slotByI = new Map(engine.slots.map((sl) => [sl.i, sl]))
  const segs = s ? engine.segmentsOf(s) : []
  const total = engine.slots.length
  const typoN = engine.slots.filter((x) => x.state === "typo").length
  const unsureN = engine.slots.filter((x) => x.state === "unsure").length
  const wrongN = engine.slots.filter((x) => x.state === "wrong").length
  const skipN = engine.slots.filter((x) => x.state === "skip").length
  const summary = engine.over ? engine.summary : null
  const top = summary ? summary.top : null

  /* ---------- 触屏端：底部答题条 ---------- */
  const dockRef = useRef<HTMLInputElement | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  /** 点答案区的词 → 弹出的操作条（存的是句子里的词下标 i）。 */
  const [wordSheet, setWordSheet] = useState<number | null>(null)
  const dockIdx = engine.activeSlotIndex()
  const dockSlot = dockIdx >= 0 ? engine.slots[dockIdx] : undefined
  const dockEditable =
    !!dockSlot &&
    !engine.finished &&
    (dockSlot.state === "empty" || dockSlot.state === "wrong")

  /**
   * 点工具条按钮后把焦点还给答题条。
   *
   * 触屏上按钮被点会抢走焦点 → 软键盘收起来，而"接着听/接着打"是这里最高频的
   * 动作，键盘一收就要用户再点一次输入框。`onMouseDown` 里 preventDefault 能
   * 阻止焦点转移（且不影响 click），再用 rAF focus 兜一层（部分浏览器只在
   * 指针抬起时转移焦点）。
   */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const backToDock = () => {
    requestAnimationFrame(() => {
      const el = dockRef.current
      if (el && document.activeElement !== el) el.focus()
    })
  }

  /* 长按空位 = 候选词。触屏上"点"要给最常用的动作（选中并改填），
     "长按"留给备选路径，才不会互相挡。 */
  const lpTimer = useRef<number | null>(null)
  const cancelLp = () => {
    if (lpTimer.current) {
      window.clearTimeout(lpTimer.current)
      lpTimer.current = null
    }
  }
  const startLp = (k: number) => {
    cancelLp()
    lpTimer.current = window.setTimeout(() => {
      lpTimer.current = null
      engine.selectSlot(k)
      engine.openCandFor(k)
    }, 380)
  }
  useEffect(() => cancelLp, [])

  /* ⚠️ 提前 return 必须放在**全部 hook 之后**。之前把它写在中间，加载完成
     那一刻 hook 数从 N 跳到 N+4，React 直接抛
     "Rendered more hooks than during the previous render."，整页白屏。 */
  if (isLoading) return <div className="practice-wrap">加载中…</div>
  if (!data)
    return (
      <div className="practice-wrap">
        课程不存在。<Link to="/dashboard/practice">返回</Link>
      </div>
    )

  return (
    // data-rev 是引擎的版本号：引擎用自己的字段驱动界面，这个属性让每次
    // bump() 都真正落到 DOM 上一次，避免任何一层 memo 把重渲吃掉。
    <div
      className="practice-wrap"
      data-rev={ver}
      data-touch={touch ? "1" : undefined}
      style={touch ? vvStyle(vv) : undefined}
    >
      <style>{CSS + DOCK_CSS}</style>
      {/* 触屏端整页钉在可视视口上，这里是「除答题条以外、可以滚的那块」 */}
      <div className="pbody">
        <div className="ph">
          <Link to="/dashboard/practice" className="back-link">
            ← 课程
          </Link>
          <h1>{engine.title}</h1>
          <div className="pmeta">
            <span>{engine.meta}</span>
            <span className="clock">{engine.clockStr}</span>
            <span className="hides">已听 {engine.tries} 次</span>
            <span className="tier">
              档 {["热身", "骨架", "半骨架", "盲打"][engine.tier]}
            </span>
          </div>
          <div className="prog">
            <div
              className="prog-bar"
              style={{
                width: `${(engine.idx / Math.max(1, engine.sentences.length)) * 100}%`,
              }}
            />
          </div>
        </div>

        {engine.gateOpen && (
          <div
            className="gate show"
            onClick={() => {
              engine.unlock()
              engine.closeGate()
              // 触屏端不主动弹键盘：此刻要先听，键盘会占掉半屏。
              // 键盘在用户点答题条时自然弹起；之后 advance() 会自己把焦点还回来。
              if (!touch) engine.refocus()
              if (engine.cur()) engine.playCurrent(false)
            }}
          >
            <div className="gate-box">
              <div className="gate-big">
                {touch ? "点一下这里开始" : "点一下这里，或按任意键"}
              </div>
              <div className="gate-sub">
                {touch ? (
                  <>
                    浏览器规定：没有一次交互就不给放声音
                    <br />
                    点完就开始第一句，之后全程不用离开屏幕
                  </>
                ) : (
                  <>
                    浏览器规定：没有一次交互就不给放声音
                    <br />
                    点完就开始第一句，之后全程不用鼠标
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {!engine.over && (
          <div className="stage">
            <div className="sentence">
              {s?.words.map((w, i) => {
                const sl = slotByI.get(i)
                if (!sl)
                  return (
                    <span key={i} className="gw">
                      {w.w}
                    </span>
                  )
                const k = engine.slots.indexOf(sl)
                if (!touch)
                  return (
                    <input
                      key={i}
                      ref={(el) => engine.registerInput(k, el)}
                      className={slotClass(sl, false)}
                      type="text"
                      value={sl.value}
                      placeholder={slotPlaceholder(sl)}
                      readOnly={
                        engine.finished ||
                        (sl.state !== "empty" && sl.state !== "wrong")
                      }
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => engine.onSlotInput(k, e.target.value)}
                      onFocus={() => {
                        engine.slotIdx = k
                        engine.updateStatus()
                      }}
                      style={{
                        width: `${Math.max(64, sl.n.length * 13 + 26)}px`,
                      }}
                    />
                  )
                /* 触屏：空位是展示格，不是 input —— 输入统一走底部答题条。
                 用 span 而不是 button：button 被点会抢走焦点、软键盘随之收起。 */
                return (
                  <span
                    key={i}
                    className={slotClass(sl, k === engine.slotIdx) + " cell"}
                    onClick={() => {
                      cancelLp()
                      engine.selectSlot(k)
                    }}
                    onPointerDown={() => startLp(k)}
                    onPointerUp={cancelLp}
                    onPointerLeave={cancelLp}
                    onPointerCancel={cancelLp}
                    style={{
                      minWidth: `${Math.max(54, sl.n.length * 12 + 22)}px`,
                    }}
                  >
                    {sl.value ? (
                      sl.value
                    ) : (
                      <i className="cell-ph">{slotPlaceholder(sl)}</i>
                    )}
                  </span>
                )
              })}
            </div>

            <div className="status">
              <span>
                第 <b>{Math.min(engine.slotIdx + 1, total || 1)}</b> / {total}{" "}
                格
              </span>
              {typoN > 0 && (
                <span className="st-typo">
                  手滑 <b>{typoN}</b>（不计分）
                </span>
              )}
              {unsureN > 0 && (
                <span className="st-typo">
                  存疑 <b>{unsureN}</b>（不计分）
                </span>
              )}
              {wrongN > 0 && (
                <span className="st-err">
                  待改 <b>{wrongN}</b>
                </span>
              )}
              {skipN > 0 && (
                <span>
                  留空 <b>{skipN}</b>
                </span>
              )}
              <span className="grow" />
              <span className="st-key">
                {engine.cands
                  ? touch
                    ? "点一下选词"
                    : "数字 1–4 选词 · Esc 收起"
                  : touch
                    ? "点空位改填 · 长按空位出候选"
                    : "灰色词是给你的 · 按住空格出命令"}
              </span>
            </div>

            {segs.length >= 2 && !engine.finished && !touch && (
              <div className="segs">
                {segs.map((_, i) => (
                  <button key={i} onClick={() => engine.playSegment(i)}>
                    {i + 1}
                  </button>
                ))}
              </div>
            )}

            {engine.cands && (
              <div className="cand show">
                <span className="lab">
                  {touch ? "听上去像哪个？点一下" : "听上去像哪个？按 1–4 选"}
                </span>
                {engine.cands.map((w, k2) => (
                  <button
                    key={k2}
                    data-c={k2}
                    onClick={() => engine.pickCand(k2)}
                  >
                    <i>{k2 + 1}</i>
                    {w}
                  </button>
                ))}
              </div>
            )}

            {engine.finished && !engine.over && (
              <div className="result show">
                <div className="verdict">{engine.verdict}</div>
                <div className="stats">
                  {(engine.lastCounts["听错"] ?? 0) > 0 && (
                    <span className="stat-err">
                      空位错 <b>{engine.lastCounts["听错"]}</b>
                    </span>
                  )}
                  {skipN > 0 && (
                    <span>
                      留空 <b>{skipN}</b>
                    </span>
                  )}
                  {typoN > 0 && (
                    <span className="stat-typo">
                      手滑 <b>{typoN}</b>（不计分）
                    </span>
                  )}
                  {unsureN > 0 && (
                    <span className="stat-unsure">
                      存疑 <b>{unsureN}</b>（不计分）
                    </span>
                  )}
                  <span>
                    空位 <b>{total}</b> 个
                  </span>
                </div>

                <div className="answer">
                  {s?.words.map((w, i) => {
                    const sl = slotByI.get(i)
                    if (!sl)
                      return (
                        <span key={i} className="w given">
                          {w.w}
                        </span>
                      )
                    const k = engine.slots.indexOf(sl)
                    const kind = engine.slotKind(sl)
                    const cls =
                      kind === "ok"
                        ? "ok"
                        : ["typo", "手滑", "漏尾", "多尾"].includes(kind)
                          ? "typo"
                          : kind === "unsure" || kind === "存疑"
                            ? "unsure"
                            : kind === "留空"
                              ? "skip"
                              : "error"
                    const fix =
                      (kind === "听错" || kind === "漏尾" || kind === "多尾") &&
                      sl.value
                        ? sl.value
                        : ""
                    const st = engine.markGet(w.w)
                    const mtag =
                      st === "known" ? "会了" : st === "ignore" ? "忽略" : ""
                    // 游标跟随 mkCursor（j/k 改的是它）；覆盖全部空位，蒙对的词也能选中。
                    // 触屏没有 j/k，游标高亮会变成"卡在某一格"的噪音，只在桌面端画。
                    const cur = !touch && k === engine.mkCursor ? " cursor" : ""
                    return (
                      <span
                        key={i}
                        className={`w ${cls}${cur}`}
                        data-i={i}
                        onClick={() =>
                          touch ? setWordSheet(i) : engine.markCursorCycle(i)
                        }
                      >
                        {w.w}
                        {sl.usedCand && <span className="mark">候选</span>}
                        {fix && <span className="fix">{fix}</span>}
                        {mtag && (
                          <i
                            className={`mktag ${st === "known" ? "on" : "off"}`}
                          >
                            {mtag}
                          </i>
                        )}
                        {engine.inWrongBook(w.w) && (
                          <i className="mktag wb">错词</i>
                        )}
                      </span>
                    )
                  })}
                </div>

                {engine.noiseList.length > 0 && (
                  <div className="noise">
                    不计分的 {engine.noiseList.length} 处（手滑 / 漏尾 / 多尾）
                    <div className="noise-list">
                      {engine.noiseList.map((n, i) => (
                        <div key={i}>
                          {n.kind} <s>{n.typed || "（空）"}</s> → {n.target}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!touch && (
                  <>
                    <div className="wbadd">
                      <button
                        className="btn tiny"
                        onClick={() => engine.addCursorToWB()}
                        title="把游标所在的词加入错词本，哪怕这题打对了"
                      >
                        加入错词本（a）
                      </button>
                      <span className="wbtoast">{wbToast ?? ""}</span>
                    </div>
                    <div className="st-key">
                      j k 走游标 · a 加入错词本 · x 会了 · c 忽略 · d 下一句 · r
                      重来 · b 明细（直接按）
                    </div>
                  </>
                )}
                {touch && (
                  <div className="st-key touch-hint">
                    点上面任意一个词 → 会了 / 忽略 / 加入错词本
                  </div>
                )}
              </div>
            )}

            {engine.layerOpen && !touch && (
              <div className="layer show">
                {engine.layerItems.map((it) => (
                  <span
                    key={it.k}
                    className={`li${it.k === "h" ? " back" : ""}`}
                  >
                    <b>{it.k}</b>
                    {it.label}
                  </span>
                ))}
                <span className="li tap">松开 = 重播</span>
              </div>
            )}
          </div>
        )}

        {engine.session && !engine.over && engine.session.log.length > 0 && (
          <div className="report">
            <h2>本轮报表 · 按错误类型</h2>
            {engine.reportRows().map((r) => (
              <div key={r.k} className={`rep-row${r.scored ? "" : " mute"}`}>
                <span className="lb">{r.k}</span>
                <span className="bar-i" style={{ width: `${r.w}px` }} />
                <span className="n">
                  {r.n}
                  {r.scored ? "" : "（不计分）"}
                </span>
              </div>
            ))}
            <div className="rep-note">
              已练 <b>{engine.session.log.length}</b> 句 · 累计听{" "}
              <b>{engine.session.listens}</b> 次
              {engine.topKind().k && (
                <>
                  <br />
                  最常错：<b>{engine.topKind().k}</b>（{engine.topKind().n}{" "}
                  次）—— {TIPS[engine.topKind().k]}
                </>
              )}
            </div>
          </div>
        )}

        {summary && (
          <div className="summary">
            <div className="card">
              <h2>本轮完成 · 按错误类型</h2>
              <div className="stats">
                <span className="stat-ok">
                  空位正确率 <b>{summary.acc}%</b>
                </span>
                <span>
                  {summary.n} 句 · 空位 {summary.totalSlots} 个 · 用时{" "}
                  <b>
                    {Math.floor(summary.elapsed / 60)}:
                    {String(Math.round(summary.elapsed % 60)).padStart(2, "0")}
                  </b>
                </span>
              </div>
              <div className="rep">
                {summary.rows.map((r) => (
                  <div
                    key={r.k}
                    className={`rep-row${r.scored ? "" : " mute"}`}
                  >
                    <span className="lb">{r.k}</span>
                    <span
                      className="bar-i"
                      style={{
                        width: `${Math.max(
                          3,
                          Math.round(
                            (r.n /
                              Math.max(1, ...summary.rows.map((x) => x.n))) *
                              130,
                          ),
                        )}px`,
                      }}
                    />
                    <span className="n">
                      {r.n}
                      {r.scored ? "" : "（不计分）"}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rep-note">
                <span
                  dangerouslySetInnerHTML={{
                    __html: summary.dose + (summary.trend ?? ""),
                  }}
                />
                {top && (
                  <>
                    <br />
                    最常错：<b>{top.k}</b>（{top.n} 次）—— {TIPS[top.k]}
                  </>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <button
                  className="btn primary"
                  onClick={() => engine.restartRound()}
                >
                  再来一轮{touch ? "" : "（直接按 d）"}
                </button>
              </div>

              {nextLesson && !doseDone && countdown > 0 && (
                <div className="nextup">
                  <div className="nextup-t">
                    <b>{countdown}</b> 秒后进入下一课
                  </div>
                  <div className="nextup-n">{nextLesson.title}</div>
                  <div className="nextup-acts">
                    <button className="btn tiny primary" onClick={() => gotoNext()}>
                      立即进入
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        autoStopRef.current = true
                        setCountdown(0)
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {nextLesson && !doseDone && countdown === 0 && !autoStopRef.current && (
                <div className="nextup">
                  <div className="nextup-n">正在进入：{nextLesson.title}…</div>
                </div>
              )}

              {/* 今天练够了：不再自动跳，只给提醒 + 一个「再练一门」的出口。
                  做提醒不做门禁 —— 想接着练的人点一下就继续，别拦着。 */}
              {nextLesson && doseDone && (
                <div className="nextup dose">
                  <div className="nextup-t done">
                    今天已练 {mmss(todaySec(progressQ.data))} ，够了（每日 {DOSE_MIN} 分钟）
                  </div>
                  <div className="nextup-n">下一课：{nextLesson.title}</div>
                  <div className="nextup-acts">
                    <button className="btn tiny primary" onClick={() => gotoNext()}>
                      再练一门
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        autoStopRef.current = true
                        setNextLesson(null)
                      }}
                    >
                      今天到此为止
                    </button>
                  </div>
                </div>
              )}

              {!nextLesson && (
                <div className="nextup idle">
                  <div className="nextup-n">这是唯一一门课，练完没有下一课了</div>
                </div>
              )}
              {engine.tierSuggestion && (
                <div className="tier-prompt">
                  <span>
                    本轮空位正确率 <b>{engine.tierSuggestion.acc}%</b> · 建议
                    {engine.tierSuggestion.to > engine.tierSuggestion.from
                      ? "升档"
                      : "降档"}
                    到 「
                    {
                      ["热身", "骨架", "半骨架", "盲打"][
                        engine.tierSuggestion.to
                      ]
                    }
                    」
                    {!touch && (
                      <>
                        · 长按空格 → <b>y</b> 接受 / <b>n</b> 忽略
                      </>
                    )}
                  </span>
                  <span className="tier-acts">
                    <button
                      className="btn tiny primary"
                      onClick={() => engine.applyTierSuggestion()}
                    >
                      接受
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => engine.dismissTierSuggestion()}
                    >
                      忽略
                    </button>
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="wb-link">
          <Link to="/dashboard/wb" className="wb-link-a">
            错词本（{wbActive} 待复习）→
          </Link>
        </div>
      </div>

      {/* ---------- 触屏端底部答题条 ---------- */}
      {touch && !engine.over && (
        <div className="dock">
          {engine.finished ? (
            <button className="dock-next" onClick={() => engine.nextSentence()}>
              下一句
            </button>
          ) : (
            <>
              <div className="dock-row">
                <input
                  ref={dockRef}
                  className={"dock-input" + (dockEditable ? "" : " off")}
                  value={dockSlot?.value ?? ""}
                  readOnly={!dockEditable}
                  placeholder={
                    dockSlot
                      ? slotPlaceholder(dockSlot)
                      : engine.cands
                        ? "从上面选一个"
                        : "默写"
                  }
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(e) => {
                    if (dockIdx >= 0)
                      engine.onSlotInput(dockIdx, e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      engine.checkAndAdvance()
                    }
                  }}
                />
                <button
                  className="dock-ok"
                  onMouseDown={keepFocus}
                  disabled={!dockEditable}
                  onClick={() => {
                    engine.checkAndAdvance()
                    backToDock()
                  }}
                  aria-label="校验并前进"
                >
                  ✓
                </button>
              </div>
              <div className="dock-chips">
                <button
                  className="chip primary"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    engine.playCurrent()
                    backToDock()
                  }}
                >
                  ▶ 播放
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    engine.playCurrent(undefined, 0.6)
                    backToDock()
                  }}
                >
                  慢放
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    engine.playSlotWord()
                    backToDock()
                  }}
                >
                  本词
                </button>
                <button
                  className="chip"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    engine.skipSlot()
                    backToDock()
                  }}
                >
                  留空
                </button>
                <button
                  className="chip danger"
                  onMouseDown={keepFocus}
                  onClick={() => engine.revealAll()}
                >
                  答案
                </button>
                <button className="chip" onClick={() => setMoreOpen(true)}>
                  更多
                </button>
                {engine.cands && (
                  <button
                    className="chip"
                    onClick={() => {
                      engine.clearCand()
                      backToDock()
                    }}
                  >
                    收起候选
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* 更多：触屏端等价于桌面的长按空格命令层 —— 键变成 chip，随状态出现/消失 */}
      {moreOpen && (
        <div className="sheet show" onClick={() => setMoreOpen(false)}>
          <div className="sheet-box" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-t">命令</div>
            <div className="sheet-grid">
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.toggleCand()
                  setMoreOpen(false)
                  backToDock()
                }}
              >
                {engine.cands ? "收起候选词" : "候选词"}
              </button>
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.restartSentence()
                  setMoreOpen(false)
                }}
              >
                重来本句
              </button>
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.prevSentence()
                  setMoreOpen(false)
                }}
              >
                上一句
              </button>
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.toggleLoop()
                  setMoreOpen(false)
                  backToDock()
                }}
              >
                循环重播 {engine.loopOn ? "开" : "关"}
              </button>
              {segs.map((_, i) => (
                <button
                  key={i}
                  className="sheet-btn"
                  onClick={() => {
                    engine.playSegment(i)
                    setMoreOpen(false)
                    backToDock()
                  }}
                >
                  第 {i + 1} 段
                </button>
              ))}
            </div>
            <button className="sheet-close" onClick={() => setMoreOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 点答案区的词：显式三选一，替掉触屏上不可发现的"点一下循环三态" */}
      {wordSheet !== null && (
        <div className="sheet show" onClick={() => setWordSheet(null)}>
          <div className="sheet-box" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-t">{s?.words[wordSheet]?.w}</div>
            <div className="sheet-grid">
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.markWordAt(wordSheet, "known")
                  setWordSheet(null)
                }}
              >
                会了
              </button>
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.markWordAt(wordSheet, "ignore")
                  setWordSheet(null)
                }}
              >
                忽略
              </button>
              <button
                className="sheet-btn"
                onClick={() => {
                  engine.addWordToWB(wordSheet)
                  setWordSheet(null)
                }}
              >
                加入错词本
              </button>
            </div>
            <button className="sheet-close" onClick={() => setWordSheet(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {touch && wbToast && (
        <div className="dock-toast" style={{ bottom: 190 }}>
          {wbToast}
        </div>
      )}

      <audio ref={audioRef} preload="auto" playsInline />
    </div>
  )
}

const TIPS: Record<string, string> = {
  听错: "词听成了另一个词 —— 这一类是真正的听力缺口",
  留空: "留空比编词好。这些词已进错词本，下一轮还会被空出来",
  漏尾: "词尾辅音簇（-s / -ed / -t）漏了 —— ESL 听力的头号问题，值得单独练",
  多尾: "多打了词尾 —— 多半把上一个词的收尾音连到了这个词上",
  手滑: "键盘动作失误，不计分",
  存疑: "转写本身没听准，不计分",
}

const CSS = `
.practice-wrap{
  --ok:#15803d;--ok-bg:#f0fdf4;--ok-bd:#bbf7d0;
  --typo:#a16207;--typo-bg:#fefce8;--typo-bd:#fde68a;
  --unsure:#c2410c;--unsure-bg:#fff7ed;--unsure-bd:#fed7aa;
  --err:#b91c1c;--err-bg:#fef2f2;--err-bd:#fecaca;
  --reveal:#1d4ed8;--reveal-bg:#eff6ff;--reveal-bd:#bfdbfe;
  --tier:#a16207;--tier-bg:#fefce8;--tier-bd:#fde68a;
  max-width:960px;margin:0 auto;padding:28px 34px 34px;
  color:var(--foreground);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;
  background:var(--card);border:1px solid var(--border);border-radius:18px;
  box-shadow:0 12px 36px -22px rgba(0,0,0,.18);
}
.dark .practice-wrap{
  --ok:#4ade80;--ok-bg:#132018;--ok-bd:#2c5c38;
  --typo:#e3cd82;--typo-bg:#1f1b12;--typo-bd:#5f5530;
  --unsure:#e2ab60;--unsure-bg:#1f1812;--unsure-bd:#5f4730;
  --err:#f0a2a2;--err-bg:#201314;--err-bd:#5c2f34;
  --reveal:#8db1ff;--reveal-bg:#141d29;--reveal-bd:#2f4465;
  --tier:#d9b36a;--tier-bg:#1f1b12;--tier-bd:#3a3222;
  box-shadow:none;
}
.practice-wrap h1{font-size:18px;font-weight:650;margin:8px 0 12px;color:var(--foreground);letter-spacing:.02em}
.back-link{display:inline-block;color:var(--muted-foreground);text-decoration:none;font-size:12.5px;transition:color .15s}
.back-link:hover{color:var(--primary)}
.pmeta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
.pmeta>span{display:inline-flex;align-items:center;background:var(--muted);border:1px solid var(--border);border-radius:999px;padding:3px 11px;font-size:12px;color:var(--muted-foreground)}
.clock{font-variant-numeric:tabular-nums}
.tier{color:var(--tier) !important;background:var(--tier-bg) !important;border-color:var(--tier-bd) !important}
.prog{height:6px;background:var(--muted);border-radius:999px;overflow:hidden;margin:0 0 24px}
.prog-bar{height:100%;background:var(--primary);border-radius:999px;transition:width .35s ease}
.stage{position:relative}
.sentence{font-size:28px;line-height:2.2;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:4px 0 2px}
.gw{color:var(--muted-foreground);font-weight:500}
input.slot{font:inherit;color:var(--foreground);background:var(--background);border:1px solid var(--input);border-bottom:2px solid var(--border);border-radius:9px;padding:4px 10px;text-align:center;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
input.slot:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in oklab,var(--primary) 18%,transparent)}
input.slot.ok{color:var(--ok);border-color:var(--ok-bd);background:var(--ok-bg)}
input.slot.typo{color:var(--typo);border-color:var(--typo-bd);background:var(--typo-bg)}
input.slot.unsure{color:var(--unsure);border-color:var(--unsure-bd);background:var(--unsure-bg)}
input.slot.wrong{color:var(--err);border-color:var(--err-bd);background:var(--err-bg)}
input.slot.skip{color:var(--muted-foreground);border-style:dashed}
input.slot.reveal{color:var(--reveal);border-color:var(--reveal-bd);background:var(--reveal-bg)}
input.slot.active{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in oklab,var(--primary) 22%,transparent)}
/* 触屏空位：展示格。span 不会被点走焦点，软键盘才不会一碰就收。 */
span.slot.cell{display:inline-flex;align-items:center;justify-content:center;min-height:40px;cursor:pointer;color:var(--foreground);background:var(--background);border:1px solid var(--input);border-bottom:2px solid var(--border);border-radius:9px;padding:0 8px;font-weight:500}
span.slot.cell .cell-ph{font-style:normal;color:var(--muted-foreground);letter-spacing:.12em;font-weight:400}
span.slot.cell.ok{color:var(--ok);border-color:var(--ok-bd);background:var(--ok-bg)}
span.slot.cell.typo{color:var(--typo);border-color:var(--typo-bd);background:var(--typo-bg)}
span.slot.cell.unsure{color:var(--unsure);border-color:var(--unsure-bd);background:var(--unsure-bg)}
span.slot.cell.wrong{color:var(--err);border-color:var(--err-bd);background:var(--err-bg)}
span.slot.cell.skip{color:var(--muted-foreground);border-style:dashed}
span.slot.cell.reveal{color:var(--reveal);border-color:var(--reveal-bd);background:var(--reveal-bg)}
span.slot.cell.active{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in oklab,var(--primary) 22%,transparent)}
.status{display:flex;gap:14px;flex-wrap:wrap;align-items:center;color:var(--muted-foreground);font-size:13px;margin-top:14px}
.status .grow{flex:1}
.status b{color:var(--foreground);font-weight:600}
.st-typo{color:var(--typo)}.st-err{color:var(--err)}
.st-key{color:color-mix(in oklab,var(--muted-foreground) 75%,transparent);font-size:12.5px}
.segs{display:flex;gap:7px;margin-top:14px}
.segs button{width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--background);color:var(--foreground);cursor:pointer;font-size:13px;transition:border-color .15s,color .15s}
.segs button:hover{border-color:var(--primary);color:var(--primary)}
.cand{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;background:var(--popover);border:1px solid var(--border);border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px -16px rgba(0,0,0,.25)}
.cand .lab{color:var(--muted-foreground);font-size:13px;margin-right:2px}
.cand button{display:flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:15px;transition:border-color .15s,background .15s}
.cand button:hover{border-color:var(--primary);background:color-mix(in oklab,var(--primary) 8%,var(--background))}
.cand button i{font-style:normal;background:var(--muted);border-radius:5px;padding:1px 7px;font-size:12px;color:var(--muted-foreground)}
.result{margin-top:20px;background:var(--muted);border:1px solid var(--border);border-radius:14px;padding:20px}
.verdict{font-size:17px;font-weight:650;margin-bottom:10px;color:var(--foreground)}
.stats{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted-foreground)}
.stats b{font-weight:600}
.stat-err{color:var(--err)}.stat-typo{color:var(--typo)}.stat-unsure{color:var(--unsure)}.stat-ok{color:var(--ok)}
.answer{margin-top:14px;font-size:23px;line-height:2.1;display:flex;flex-wrap:wrap;gap:4px 10px}
.answer .w{position:relative;padding:0 3px;border-radius:5px}
.answer .w.given{color:var(--muted-foreground)}
.answer .w.ok{color:var(--ok)}
.answer .w.typo{color:var(--typo)}
.answer .w.unsure{color:var(--unsure)}
.answer .w.skip{color:var(--muted-foreground)}
.answer .w.error{color:var(--err)}
.answer .w.cursor{outline:2px solid var(--primary);border-radius:5px}
.answer .w .fix{position:absolute;left:0;top:100%;font-size:13px;color:var(--err)}
.answer .w .mark{font-size:11px;color:var(--primary);margin-left:3px}
.answer .w .mktag{font-style:normal;font-size:11px;margin-left:3px;color:var(--muted-foreground)}
.answer .w .mktag.on{color:var(--ok)}.answer .w .mktag.off{color:var(--err)}
.answer .w .mktag.wb{color:var(--err)}
.wbadd{display:flex;align-items:center;gap:10px;margin-top:10px}
.btn.tiny{background:var(--muted);color:var(--foreground);border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;transition:border-color .15s,color .15s}
.btn.tiny:hover{border-color:var(--primary);color:var(--primary)}
.wbtoast{font-size:12.5px;color:var(--ok)}
.noise{margin-top:12px;font-size:13px;color:var(--muted-foreground)}
.noise-list s{color:var(--err)}
.layer{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:8px;flex-wrap:wrap;background:var(--popover);border:1px solid var(--border);border-radius:12px;padding:10px 14px;max-width:92vw;z-index:50;box-shadow:0 14px 40px -12px rgba(0,0,0,.35)}
.layer .li{display:flex;align-items:center;gap:6px;background:var(--background);border:1px solid var(--border);border-radius:7px;padding:5px 10px;font-size:14px}
.layer .li b{background:var(--muted);border-radius:5px;padding:0 7px;min-width:18px;text-align:center;font-weight:600}
.layer .li.back{border-color:color-mix(in oklab,var(--primary) 45%,var(--border));color:var(--primary)}
.layer .li.tap{color:var(--muted-foreground);border:none;background:none}
.report{margin-top:20px;background:var(--muted);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
.report h2{font-size:12px;margin:0 0 12px;letter-spacing:.14em;color:var(--muted-foreground);font-weight:600}
.rep-row{display:flex;align-items:center;gap:12px;margin:6px 0;font-size:13px}
.rep-row.mute{opacity:.5}
.rep-row .lb{width:52px;color:var(--foreground)}
.rep-row .bar-i{height:8px;background:var(--primary);border-radius:999px;display:inline-block}
.rep-row.mute .bar-i{background:var(--ring)}
.rep-row .n{color:var(--muted-foreground)}
.rep-note{margin-top:12px;color:var(--muted-foreground);font-size:13px;line-height:1.8}
.rep-note b{color:var(--foreground)}
.summary{margin-top:20px}
.summary .card{background:var(--muted);border:1px solid var(--border);border-radius:14px;padding:20px}
.summary .card h2{font-size:12px;margin:0 0 12px;letter-spacing:.14em;color:var(--muted-foreground);font-weight:600}
.btn.primary{background:var(--primary);color:var(--primary-foreground);border:none;border-radius:9px;padding:10px 20px;font-weight:600;cursor:pointer;transition:filter .15s}
.btn.primary:hover{filter:brightness(1.12)}
.wb{margin-top:20px;border:1px solid var(--border);border-radius:14px;background:var(--muted);overflow:hidden}
.wb-head{padding:13px 18px;cursor:pointer;font-weight:600;font-size:14px;user-select:none;color:var(--foreground);transition:background .15s}
.wb-head:hover{background:color-mix(in oklab,var(--foreground) 4%,transparent)}
.wb-list{padding:0 18px 14px}
.wb-row{display:grid;grid-template-columns:1fr 1fr 1.4fr auto;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--border);font-size:13px}
.wb-row.mk-off{opacity:.5}
.wb-row .w1{font-weight:600;color:var(--foreground)}
.wb-row .w2{color:var(--err)}
.wb-row .w3{color:var(--muted-foreground)}
.wb-row .mkb{display:flex;gap:6px}
.wb-row .mk{border:1px solid var(--border);background:var(--background);color:var(--muted-foreground);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px;transition:border-color .15s,color .15s}
.wb-row .mk:hover{border-color:var(--primary);color:var(--primary)}
.wb-row .mk.on{color:var(--ok);border-color:var(--ok-bd);background:var(--ok-bg)}
.gate{position:fixed;inset:0;background:color-mix(in srgb,var(--background) 70%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;color:var(--foreground);font-size:18px;cursor:pointer;z-index:60}
.gate .gate-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 38px;text-align:center;box-shadow:0 18px 50px -12px rgba(0,0,0,.3);max-width:88vw}
.gate .gate-big{font-size:17px;font-weight:600;margin-bottom:8px;color:var(--foreground)}
.gate .gate-sub{font-size:13px;color:var(--muted-foreground);line-height:1.8}
.summary .card .tier-prompt{margin-top:14px;padding:10px 14px;background:var(--background);border:1px solid var(--border);border-radius:9px;color:var(--muted-foreground);font-size:13.5px}
.summary .card .tier-prompt b{color:var(--foreground);font-weight:600}
.tier-prompt{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tier-acts{display:inline-flex;gap:8px;flex:none}
.btn.tiny.primary{background:var(--primary);color:var(--primary-foreground);border:none;padding:5px 12px;font-size:12.5px;border-radius:8px;font-weight:600}
.btn.tiny.primary:hover{filter:brightness(1.12)}
/* 练完的「下一课」条：倒计时数字要显眼（它是这一块里唯一的动态信息），
   课名允许折行（文件名可能很长），两个按钮靠右下。 */
.nextup{margin-top:12px;padding:12px 14px;background:var(--background);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.nextup.idle{background:none;border-style:dashed;padding:10px 14px}
/* 练够剂量那一档：框还在（给「再练一门」的出口），但不倒计时 —— 用左侧色条
   和 idle 区分开，避免"框里没倒计时"被读成坏了。 */
.nextup.dose{border-left:3px solid var(--ok)}
.nextup-t.done{color:var(--ok)}
.nextup-t{font-size:13.5px;color:var(--muted-foreground)}
.nextup-t b{color:var(--primary);font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.nextup-n{font-size:13.5px;color:var(--foreground);font-weight:600;word-break:break-all}
.nextup.idle .nextup-n{font-weight:400;color:var(--muted-foreground)}
.nextup-acts{display:flex;gap:8px;margin-top:2px}

/* ---------- 触屏端布局（答题条的样式在 lib/dock-css.ts，两个页面共用） ---------- */
/* 整页钉在**可视视口**上。手机上软键盘只压缩可视视口、不压缩布局视口，
   所以按布局视口排的版一弹键盘，正在打的那几行就落到键盘下面去了。
   --vvh / --vvo 由 useVisualViewport() 写进来（键盘没弹时就是整屏）。
   内部是 flex 列：.pbody 拿走剩下的全部高度，句子靠 margin-top:auto 贴到
   答题条上方（键盘一弹容器变矮，句子自动被顶进可见区），答题条贴在最下沿
   ——也就是键盘上沿。transform 还顺带把页内那些 position:fixed 浮层
   （起播门 / 命令层 / 答案面板）的定位基准收回本页范围内。
   背景必须**不透明**：这一层盖住了 app 外壳的顶栏（汉堡 / Wordmark），
   透明的话顶栏会从底下透上来和页头叠在一起（实测截图里能看到重影）。 */
.practice-wrap[data-touch="1"]{
  position:fixed;left:0;right:0;top:0;margin:0;
  height:var(--vvh,100vh);transform:translateY(var(--vvo,0px));
  display:flex;flex-direction:column;overflow:hidden;
  max-width:none;background:var(--background);border:none;box-shadow:none;border-radius:0;padding:0;
}
.practice-wrap[data-touch="1"] .pbody{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;padding:8px 14px 14px}
/* 触屏端重排成「页头 → 本轮报表 → 错词本链接 → 句子」：句子排在最后一块，
   再用 margin-top:auto 顶死答题条上方 —— 这就是屏幕底部。键盘一弹容器变矮
   （--vvh），先让位的是页头的元信息和报表（overflow:hidden 从底下裁），
   句子永远完整、永远在底部，不用算任何偏移、也不用滚。 */
.practice-wrap[data-touch="1"] .pbody>.ph{order:1;flex:0 1 auto;min-height:48px;overflow:hidden}
.practice-wrap[data-touch="1"] .pbody>.report{order:2;flex:0 1 auto;min-height:0;overflow:hidden}
.practice-wrap[data-touch="1"] .pbody>.wb-link{order:3;flex:0 0 auto}
.practice-wrap[data-touch="1"] .pbody>.stage{order:4;margin-top:auto;flex:0 0 auto}
.practice-wrap[data-touch="1"] .pbody>.summary{order:5}
/* 答题条不再是 fixed：它是这条 flex 列的最后一行，键盘一弹自动跟着上移。
   flex:0 0 auto —— 句子很长时宁可让上面那块溢出滚动，也别把答题条挤扁。 */
.practice-wrap[data-touch="1"] .dock{position:static;flex:0 0 auto}
.practice-wrap[data-touch="1"] h1{font-size:16px;margin:6px 0 8px}
.practice-wrap[data-touch="1"] .prog{margin-bottom:16px}
/* 返回链接在手机上也是要点的按钮，别只有 15px 高 */
.practice-wrap[data-touch="1"] .back-link{display:inline-flex;align-items:center;min-height:44px;padding-right:10px}
.practice-wrap[data-touch="1"] .pmeta .hides{display:none}
.practice-wrap[data-touch="1"] .pmeta>span{padding:2px 9px}
.practice-wrap[data-touch="1"] .sentence{font-size:22px;line-height:1.7;gap:10px 10px}
/* 空位在手机上就是要点的按钮，触控目标 ≥44px */
.practice-wrap[data-touch="1"] .slot.cell{min-height:44px}
.practice-wrap[data-touch="1"] .status{margin-top:12px}
.practice-wrap[data-touch="1"] .answer{font-size:20px;line-height:2}
.practice-wrap[data-touch="1"] .answer .w{padding:6px 5px;cursor:pointer}
.practice-wrap[data-touch="1"] .gate-box{padding:24px 22px}
.practice-wrap[data-touch="1"] .report{padding:14px 16px}
.practice-wrap[data-touch="1"] .summary .card{padding:16px}
.practice-wrap[data-touch="1"] .btn.primary{padding:13px 22px;font-size:15px}
.touch-hint{margin-top:8px}
@media (max-width:640px){.practice-wrap{padding:20px 18px 26px;border-radius:14px}.sentence{font-size:22px;line-height:2}.answer{font-size:19px}}
`
