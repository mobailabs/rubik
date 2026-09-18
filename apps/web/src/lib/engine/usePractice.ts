import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { isTouchDevice } from "./device"
import {
  TIERS,
  bare,
  blankTargets,
  distractorsFor,
  endingKind,
  norm,
  tierRatio,
  wordVerdict,
} from "./judge"
import type {
  AttemptPayload,
  LayerItem,
  LessonContent,
  Sentence,
  Session,
  Slot,
  Word,
  WrongWordRecord,
} from "./types"

/* 切片留白：ASR 段边界是"语音实际首尾"，前后各留一段再用音量斜坡磨平 */
const LEAD = 0.35,
  TAIL = 0.25,
  FADE = 0.07
const PAD_SENT = 1,
  PAD_SEG = 0.7,
  PAD_WORD = 0.45
const DOSE_SEC = 18 * 60
const BACK = "h" // 返回键：右手食指 home row，永远在层里、位置固定
const TERMS = ["听错", "留空", "漏尾", "多尾", "手滑", "存疑"]
const SCORED: Record<string, boolean> = {
  听错: true,
  留空: true,
  漏尾: false,
  多尾: false,
  手滑: false,
  存疑: false,
}

/* 触屏端只有一个输入框（底部答题条），判定沿用 device.ts 的单一来源。 */
const IS_TOUCH = isTouchDevice()

/** 答题条输入框的 class。引擎靠它区分"在答题条里打字"和"在页面上乱按字母"。 */
export const DOCK_CLASS = "dock-input"

function mmss(sec: number): string {
  sec = Math.max(0, Math.round(sec))
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0")
}
interface LayerCmd {
  k: string
  label: string
  fn?: () => void
}

/* ---------- localStorage 安全读写（SSR / 测试环境不炸） ---------- */
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
  } catch {}
}
const TIER_KEY = "et_tier_v1"
const MARK_KEY = "et_wordmark_v1"
const MAX_TIER = 3  // 与路由 ["热身","骨架","半骨架","盲打"] 同步
const TIER_UP_ACC = 90
const TIER_DOWN_ACC = 75
const RESUME_KEY = "et_resume_v1:"

/**
 * 读某门课的本机断点（第几句），不依赖引擎实例。
 *
 * 课程列表页要在卡片上显示「第 14/32 句」，那里没有引擎、也不该为此建一个。
 * 键的拼法只此一处，引擎的 `loadCheckpoint` 也走它 —— 两边各写一份前缀，
 * 改了一处忘了另一处就是"进度条对不上"的静默 bug。
 */
export function readResumeCheckpoint(
  id: string,
): { idx: number; savedAt: number } | null {
  const raw = lsGet(RESUME_KEY + id)
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { idx?: unknown; savedAt?: unknown }
    if (typeof o.idx === "number" && Number.isFinite(o.idx)) {
      return { idx: o.idx, savedAt: typeof o.savedAt === "number" ? o.savedAt : 0 }
    }
  } catch {
    /* 损坏的存档直接忽略 */
  }
  return null
}

export class PracticeEngine {
  audioRef: React.RefObject<HTMLAudioElement | null>
  onSave?: (p: AttemptPayload) => void
  /**
   * 引擎算到错词时吐出该 row 给路由侧去写库。失败由调用方吞。
   *
   * `source` 区分两种来源：
   * - `auto`   —— finishSentence 判出来的错词（听错 / 留空 / 漏尾 / 多尾）
   * - `manual` —— 用户主动按 `a` 把游标词塞进错词本。哪怕这题打对了也能加，
   *               路由侧据此带 `unmaster` 写库（把已标「会了」的行拉回活跃）+ 给提示。
   */
  onWrongWord?: (row: WrongWordRecord, source?: "auto" | "manual") => void
  bump: () => void

  // 播放态
  private spanEnd: number | null = null
  private pendingSeek: number | null = null
  private seekTimer: number | null = null
  private fadeFrom = 0
  private fadeTo = 0
  private loopTimer: number | null = null
  private audioUnlocked = false
  /** 循环重播开关。界面要显示「开/关」（桌面的 l 键标签、触屏的「更多」面板），
   *  所以是公开状态而不是内部实现细节。 */
  loopOn = false
  /** 每次 playSpan 递增；过期的 play() 报错一律忽略，别把起播门弹回来 */
  private playToken = 0
  rate = 1.0

  // 课程态
  lessonId = ""
  title = ""
  sentences: Sentence[] = []
  audioUrl = ""
  idx = 0
  finished = false
  over = false
  gateOpen = true

  // 槽态
  slots: Slot[] = []
  slotIdx = 0
  inputRefs = new Map<number, HTMLInputElement>()

  // 命令层
  spaceHeld = false
  spaceHit = false
  layerOpen = false
  layerItems: LayerItem[] = []

  // 候选面板
  cands: string[] | null = null

  // 会话
  session: Session | null = null
  sessionGood = 0
  sessionSlots = 0
  streak = 0
  missStreak = 0
  tries = 0
  tier = 1
  lastTierDir = 1

  // 结算展示
  mkCursor = 0
  verdict = ""
  lastCounts: Record<string, number> = {}
  noiseList: { kind: string; typed: string; target: string }[] = []
  meta = ""
  clockStr = "0:00"
  summary: {
    acc: number
    n: number
    totalSlots: number
    elapsed: number
    rows: { k: string; n: number; scored: boolean }[]
    top: { k: string; n: number } | null
    trend: string
    dose: string
  } | null = null
  noiseOpen = false
  /** 课程载入时把当前用户 wb 里的活跃词集合传进来（仅读，引擎不持久化）。 */
  knownWrong: Set<string> = new Set<string>()

  constructor(
    audioRef: React.RefObject<HTMLAudioElement | null>,
    bump: () => void,
    onSave?: (p: AttemptPayload) => void,
    /** 引擎识别出听错 / 留空 / 漏尾 / 多尾时调，便于路由侧写库。失败路由自己吞。 */
    onWrongWord?: (row: WrongWordRecord) => void,
  ) {
    this.audioRef = audioRef
    this.bump = bump
    this.onSave = onSave
    this.onWrongWord = onWrongWord
  }

  /* ---------- 词级标记 ---------- */
  markLoad(): Record<string, string> {
    try {
      return JSON.parse(lsGet(MARK_KEY) || "{}")
    } catch {
      return {}
    }
  }
  markGet(w: string): string {
    return this.markLoad()[norm(w)] || "learning"
  }
  markSet(w: string, state: string) {
    const nz = norm(w)
    if (!nz) return
    const m = this.markLoad()
    if (state === "learning") delete m[nz]
    else m[nz] = state
    lsSet(MARK_KEY, JSON.stringify(m))
  }

  toggleNoise() {
    this.noiseOpen = !this.noiseOpen
    this.bump()
  }
  /** 循环重播开关：开着时，当前句播完且还没填字会隔 600ms 自动重播。 */
  toggleLoop() {
    this.loopOn = !this.loopOn
    this.bump()
  }

  /* ---------- 载入 ---------- */
  loadLesson(
    content: LessonContent,
    audioUrl: string,
    id: string,
    title: string,
    /** 该用户活跃 wb 词集（已归一化），用于 fill-blanks 排序。空 = 无历史错词。 */
    knownWrong?: Set<string>,
  ) {
    // 兼容两种存储形态：DB 直接存句子数组，或包成 { sentences: [...] }
    const arr: Sentence[] = Array.isArray(content)
      ? content
      : (content?.sentences ?? [])
    this.sentences = arr
    this.audioUrl = audioUrl
    this.lessonId = id
    this.title = title
    this.knownWrong = knownWrong ?? new Set<string>()
    const v = parseInt(lsGet(TIER_KEY) || "", 10)
    if (v >= 0 && v < TIERS.length) this.tier = v
    this.idx = 0
    this.sessionGood = 0
    this.sessionSlots = 0
    this.streak = 0
    this.missStreak = 0
    this.session = {
      start: Date.now(),
      sentStart: Date.now(),
      slots: 0,
      good: 0,
      listens: 0,
      types: {},
      log: [],
    }
    if (this.audioRef.current) {
      this.audioRef.current.src = audioUrl
      this.audioRef.current.preservesPitch = true
      ;(this.audioRef.current as unknown as { webkitPreservesPitch: boolean }).webkitPreservesPitch = true
    }
    this.gateOpen = !this.audioUnlocked
    this.loadSentence()
  }

  cur(): Sentence | undefined {
    return this.sentences[this.idx]
  }

  /* ---------- 断点续练（纯前端 localStorage，不依赖后端） ---------- */
  /** 读出上次离开时的句子下标；无记录/损坏返回 null。 */
  loadCheckpoint(id: string): { idx: number; savedAt: number } | null {
    return readResumeCheckpoint(id)
  }
  /** 把当前句子下标写回 localStorage；未载入课程则跳过。 */
  saveCheckpoint() {
    if (!this.lessonId) return
    lsSet(RESUME_KEY + this.lessonId, JSON.stringify({ idx: this.idx, savedAt: Date.now() }))
  }
  /** 一轮结束后清掉断点，下次从第一句开始。 */
  clearCheckpoint() {
    if (!this.lessonId) return
    try {
      localStorage.removeItem(RESUME_KEY + this.lessonId)
    } catch {
      /* 忽略 */
    }
  }

  /* ---------- 播放 ---------- */
  private get audio(): HTMLAudioElement | null {
    return this.audioRef.current
  }
  unlock(): boolean {
    if (this.audioUnlocked) return false
    this.audioUnlocked = true
    this.gateOpen = false
    /* 用这次点击的手势把 audio 元素"激活"。
       音频常还没加载到有元数据（readyState < 1），那时 playSpan 会挂到
       loadedmetadata 上再播，而等到事件触发早就脱离用户手势了，play() 会被
       自动播放策略拒掉、起播门又被弹回来。所以这里先空播一次把手势消耗掉：
       元素一旦出过声，后面的 seek + play 都不再受限。 */
    const a = this.audio
    if (a) {
      const token = this.playToken
      const kick = a.play() as unknown as Promise<void> | undefined
      if (kick && typeof kick.then === "function") {
        kick
          .then(() => {
            // 期间没有新的播放请求接手 —— 把这次空播停掉，交给 playCurrent
            if (this.playToken === token) a.pause()
          })
          .catch(() => {})
      }
    }
    this.bump()
    return true
  }
  /**
   * 无条件收起起播门。
   * 门一旦卡住就是全屏遮罩，底下的词槽、错词本全点不到 —— 所以只要用户
   * 明确点过/按过，就一定要把它关掉，哪怕音频这次没播成。
   */
  closeGate() {
    if (!this.gateOpen) return false
    this.gateOpen = false
    this.bump()
    return true
  }
  playSpan(start: number, end: number, r?: number, pad?: number) {
    const a = this.audio
    if (!a) return
    const token = ++this.playToken
    const go = () => {
      const p = pad === undefined ? PAD_SENT : pad
      const s = Math.max(0, start - LEAD * p)
      let e = end + TAIL * p
      if (e <= s) e = s + 0.5
      this.spanEnd = e
      this.fadeFrom = s
      this.fadeTo = e
      a.volume = 0
      a.playbackRate = r || this.rate
      this.pendingSeek = s
      if (this.seekTimer) clearTimeout(this.seekTimer)
      this.seekTimer = window.setTimeout(() => {
        this.pendingSeek = null
      }, 800)
      a.currentTime = s
      a.play().catch((err: unknown) => {
        // 已经被更新的播放请求取代，或者只是被下一次 play 打断（AbortError）
        // —— 都不是"没解锁"，别把起播门弹回来挡住正在响的音频。
        if (token !== this.playToken) return
        const name = (err as { name?: string } | null | undefined)?.name
        if (name && name !== "NotAllowedError") return
        this.audioUnlocked = false
        this.stopLoop()
        this.gateOpen = true
        this.bump()
      })
    }
    if (a.readyState >= 1) go()
    else a.addEventListener("loadedmetadata", go, { once: true })
  }
  stopLoop() {
    if (this.loopTimer) clearTimeout(this.loopTimer)
    this.loopTimer = null
  }
  maybeLoop() {
    this.stopLoop()
    if (!this.audioUnlocked || !this.loopOn || this.finished || this.cands) return
    if (this.slots.some((sl) => sl.value.trim())) return
    this.loopTimer = window.setTimeout(() => {
      if (
        this.audioUnlocked &&
        this.loopOn &&
        !this.finished &&
        !this.cands &&
        !this.slots.some((sl) => sl.value.trim())
      )
        this.playCurrent(false)
    }, 600)
  }
  /** 音频 tick：音量斜坡 + 切片结束判定 + 自动循环（由组件 requestAnimationFrame 驱动） */
  tick() {
    const a = this.audio
    if (!a) return
    if (this.pendingSeek !== null) {
      if (Math.abs(a.currentTime - this.pendingSeek) < 0.15) {
        this.pendingSeek = null
        if (this.seekTimer) clearTimeout(this.seekTimer)
      }
    } else if (this.spanEnd !== null && a.currentTime >= this.spanEnd - 0.02) {
      a.volume = 0
      a.pause()
      this.spanEnd = null
      this.maybeLoop()
    }
    this.rampVolume()
  }
  private rampVolume() {
    const a = this.audio
    if (!a || a.paused || this.spanEnd === null) return
    const t = a.currentTime
    const f = Math.min(FADE, (this.fadeTo - this.fadeFrom) / 4)
    if (f <= 0) return
    let v = 1
    if (t - this.fadeFrom < f) v = Math.max(0, (t - this.fadeFrom) / f)
    if (this.fadeTo - t < f) v = Math.min(v, Math.max(0, (this.fadeTo - t) / f))
    a.volume = v
  }
  playCurrent(count?: boolean, r?: number) {
    this.stopLoop()
    const s = this.cur()
    if (!s) return
    this.playSpan(s.start, s.end, r, PAD_SENT)
    if (count !== false) {
      this.tries++
      this.bump()
    }
  }
  playSegment(k: number) {
    const segs = this.segmentsOf(this.cur()!)
    if (k < 0 || k >= segs.length) return
    this.stopLoop()
    this.playSpan(segs[k].start, segs[k].end, undefined, PAD_SEG)
    this.tries++
    this.bump()
  }
  playSlotWord() {
    const sl = this.slots[this.slotIdx]
    if (!sl) return
    this.stopLoop()
    this.playSpan(sl.w.s, sl.w.e, 0.85, PAD_WORD)
    this.tries++
    this.bump()
  }

  segmentsOf(s: Sentence): { start: number; end: number; words: Word[] }[] {
    const n = s.words.length
    const count = Math.min(4, Math.max(1, Math.ceil(n / 4)))
    const segs: { start: number; end: number; words: Word[] }[] = []
    let i = 0
    for (let k = 0; k < count; k++) {
      const take = Math.ceil((n - i) / (count - k))
      const chunk = s.words.slice(i, i + take)
      i += take
      if (chunk.length)
        segs.push({
          start: chunk[0].s,
          end: chunk[chunk.length - 1].e,
          words: chunk,
        })
    }
    return segs
  }

  /* ---------- 句子骨架渲染 ---------- */
  loadSentence() {
    this.finished = false
    this.over = false
    this.tries = 0
    this.stopLoop()
    this.clearCand()
    this.session!.sentStart = Date.now()
    this.verdict = ""
    this.lastCounts = {}
    this.noiseList = []
    this.bump()
    this.renderSegs()
    this.renderSentence()
    this.meta =
      `${this.idx + 1} / ${this.sentences.length}` +
      (this.sessionSlots
        ? `  ·  空位正确率 ${Math.round((this.sessionGood / this.sessionSlots) * 100)}%`
        : "")
    this.bump()
    this.playCurrent()
    this.bump()
  }
  gotoIdx(n: number) {
    if (n < 0 || n >= this.sentences.length) return
    this.idx = n
    this.loadSentence()
    this.saveCheckpoint()
  }
  renderSegs() {
    this.bump()
  }
  renderSentence() {
    const s = this.cur()
    if (!s) return
    const plan = blankTargets(s.words, tierRatio(this.tier), {
      wrongSet: this.knownWrong,
      marks: this.markLoad(),
    })
    const slotOf = new Set<number>(plan)

    this.slots = []
    this.slotIdx = 0
    this.cands = null
    this.inputRefs = new Map()
    s.words.forEach((w, i) => {
      if (!slotOf.has(i)) return
      const nz = norm(w.w)
      this.slots.push({
        i,
        w,
        n: nz,
        value: "",
        state: "empty",
        everWrong: false,
        usedCand: false,
        firstWrong: null,
      })
    })
    this.updateStatus()
    if (this.slots.length) {
      if (IS_TOUCH) this.markActive()
      // React 先把新槽渲染、把 inputRefs 填好，再 commit；此刻同步 focus 拿不到节点。
      // 延到下一帧（commit 之后）再聚焦首个空位，等价于原版“建好 DOM 立刻 focus”。
      else if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(() => this.focusSlot(0))
      else this.focusSlot(0)
    }
    this.bump()
  }

  nextFocusableAfter(k: number): number {
    for (let j = k + 1; j < this.slots.length; j++) {
      const st = this.slots[j].state
      if (st === "empty" || st === "wrong") return j
    }
    return -1
  }
  updateStatus() {
    this.bump()
  }
  /**
   * 焦点在一处「正在收字」的输入里吗？
   *
   * 桌面端是词槽 input（每个空位一个），触屏端是底部答题条。触屏这条路必须
   * 认得 —— 否则下面的「打任意字符把焦点拉回词槽」会接管答题条的每一个按键，
   * 而触屏端 inputRefs 是空的，取出来是 undefined，`.value` 直接抛 TypeError。
   */
  inSlot(): boolean {
    const a = document.activeElement as HTMLElement | null
    if (!a || !a.classList) return false
    return a.classList.contains("slot") || a.classList.contains(DOCK_CLASS)
  }
  activeSlot(): Slot | null {
    if (!this.slots.length) return null
    const open = (s: Slot) => s.state === "empty" || s.state === "wrong"
    if (this.slots[this.slotIdx] && open(this.slots[this.slotIdx])) return this.slots[this.slotIdx]
    return this.slots.find(open) || this.slots[this.slots.length - 1]
  }
  /** 答题条该编辑哪一格。找不到（整句已完成）= -1。 */
  activeSlotIndex(): number {
    const sl = this.activeSlot()
    if (!sl) return -1
    return this.slots.indexOf(sl)
  }
  /** 触屏端选中某一格：只有还能填的格可选中，打完的格点了不响应（点它=看词）。 */
  selectSlot(k: number): boolean {
    const sl = this.slots[k]
    if (!sl || this.finished) return false
    if (sl.state !== "empty" && sl.state !== "wrong") return false
    this.slotIdx = k
    this.clearCand()
    this.updateStatus()
    return true
  }
  focusSlot(j: number) {
    // 触屏端没有词槽 input，焦点永远留在答题条上（否则点一下按钮键盘就收，
    // 而"接着打下一个词"是这里最高频的动作）。
    if (IS_TOUCH) {
      const dock = document.querySelector<HTMLInputElement>(
        "." + DOCK_CLASS,
      )
      if (dock && document.activeElement !== dock) dock.focus()
      return
    }
    const el = this.inputRefs.get(j)
    if (el) {
      el.focus()
      try {
        el.select()
      } catch {}
    }
  }
  refocus(): Slot | null {
    const sl = this.activeSlot()
    if (!sl) return null
    this.focusSlot(this.slots.indexOf(sl))
    return sl
  }
  markActive() {
    if (!IS_TOUCH || !this.slots.length) return
    this.bump()
  }

  /* ---------- 词槽校验 ---------- */
  registerInput(k: number, el: HTMLInputElement | null) {
    if (el) this.inputRefs.set(k, el)
    else this.inputRefs.delete(k)
  }
  onSlotInput(k: number, rawValue: string) {
    const sl = this.slots[k]
    if (!sl) return
    sl.value = rawValue
    this.stopLoop()
    this.clearCand()
    if (sl.state === "wrong") {
      sl.state = "empty"
    }
    if (sl.state === "empty" && sl.n && norm(rawValue) === sl.n) {
      this.markOk(sl, rawValue)
      this.advance()
      return
    }
    this.updateStatus()
  }
  markOk(sl: Slot, raw: string) {
    sl.state = "ok"
    sl.value = raw || sl.value
    this.clearCand()
    this.bump()
  }
  markTypo(sl: Slot, raw: string) {
    sl.state = "typo"
    sl.value = raw || sl.value
    this.clearCand()
    this.bump()
  }
  markUnsure(sl: Slot, raw: string) {
    sl.state = "unsure"
    sl.value = raw || sl.value
    this.clearCand()
    this.bump()
  }
  markWrong(sl: Slot, raw: string) {
    sl.state = "wrong"
    sl.everWrong = true
    if (sl.firstWrong === undefined || sl.firstWrong === null) sl.firstWrong = raw || sl.value || ""
    sl.value = raw || sl.value
    this.clearCand()
    this.updateStatus()
  }
  checkAndAdvance() {
    if (this.finished) return
    const sl = this.slots[this.slotIdx]
    if (!sl) return this.finishSentence()
    if (["ok", "typo", "unsure", "skip"].includes(sl.state)) return this.advance()
    if (sl.state === "wrong") {
      sl.state = "wrongFinal"
      return this.advance()
    }
    const raw = sl.value.trim()
    if (!norm(raw)) {
      this.markWrong(sl, "")
      return
    }
    const v = wordVerdict(sl.n, raw, sl.w.p)
    if (v === "ok") {
      this.markOk(sl, raw)
      return this.advance()
    }
    if (v === "typo") {
      this.markTypo(sl, raw)
      return this.advance()
    }
    if (v === "unsure") {
      this.markUnsure(sl, raw)
      return this.advance()
    }
    this.markWrong(sl, raw)
  }
  skipSlot() {
    if (this.finished) return
    const sl = this.slots[this.slotIdx]
    if (!sl) return
    if (["ok", "typo", "unsure", "skip"].includes(sl.state)) return this.advance()
    sl.state = "skip"
    sl.value = ""
    this.clearCand()
    this.advance()
  }
  advance() {
    this.clearCand()
    let j = this.nextFocusableAfter(this.slotIdx)
    if (j < 0) j = this.slots.findIndex((s) => s.state === "empty" || s.state === "wrong")
    if (j < 0) return this.finishSentence()
    this.slotIdx = j
    this.markActive()
    this.focusSlot(j)
    this.updateStatus()
  }
  revealAll() {
    if (this.finished) return
    this.slots.forEach((sl) => {
      if (sl.state === "empty" || sl.state === "wrong") {
        sl.state = "reveal"
        sl.everWrong = true
        sl.value = bare(sl.w.w)
      }
    })
    this.finishSentence()
  }

  /* ---------- 候选词面板 ---------- */
  vocabOfLesson(): string[] {
    const out: string[] = []
    this.sentences.forEach((s) =>
      s.words.forEach((w) => {
        const nz = norm(w.w)
        if (nz && out.indexOf(nz) < 0) out.push(nz)
      }),
    )
    return out
  }
  clearCand() {
    this.cands = null
    this.bump()
  }
  toggleCand(force?: boolean) {
    if (this.finished) return
    const sl = this.slots[this.slotIdx]
    if (!sl) return
    if (this.cands && !force) {
      this.clearCand()
      this.updateStatus()
      return
    }
    if (!force && sl.state !== "empty" && sl.state !== "wrong") return
    if (!sl.cands) sl.cands = distractorsFor(sl.w.w, this.vocabOfLesson())
    this.cands = sl.cands
    this.updateStatus()
  }
  openCandFor(k: number | null) {
    if (k == null || !this.slots[k]) return
    this.slotIdx = k
    this.toggleCand(true)
  }
  pickCand(k: number) {
    if (!this.cands || this.finished) return
    const sl = this.slots[this.slotIdx]
    if (!sl) return
    const w = this.cands[k]
    if (!w) return
    sl.usedCand = true
    this.clearCand()
    if (norm(w) === sl.n) {
      this.markOk(sl, w)
      this.advance()
    } else {
      this.markWrong(sl, w)
    }
  }

  /* ---------- 结算 ---------- */
  slotKind(sl: Slot): string {
    if (sl.state === "ok") return "ok"
    if (sl.state === "skip") return "留空"
    if (sl.state === "unsure") return "存疑"
    if (sl.state === "typo")
      return endingKind(sl.n, norm(sl.value)) || "手滑"
    return "听错"
  }
  /** 错词本用的归一化：保留撇号（don't ≠ dont），与 judge 的 norm() 不同。 */
  wordNormOf(w: string): string {
    return bare(w).toLowerCase().replace(/[^a-z0-9']/g, "")
  }
  /** 该词是否已在活跃错词本里 —— 答案区打「错词」标记用（纯展示，不写库）。 */
  inWrongBook(w: string): boolean {
    return this.knownWrong.has(this.wordNormOf(w))
  }
  markableSlots(): Slot[] {
    return this.slots.filter((sl) => this.slotKind(sl) !== "ok")
  }
  renderAnswer() {
    this.bump()
  }
  /**
   * 结算后 j/k 走的游标。覆盖**全部**空位（不只是错的）—— 手动加入错词本
   * 要能落在蒙对的词上，只在错词间跳就没法加那种词了。
   */
  moveCursor(dir: number) {
    const list = this.slots
    if (!list.length) return
    const i = list.indexOf(this.slots[this.mkCursor])
    this.mkCursor = ((i < 0 ? 0 : i + dir) + list.length) % list.length
    this.renderAnswer()
  }
  markCursor(state: string) {
    const sl = this.slots[this.mkCursor]
    if (!sl) return
    const w = bare(sl.w.w)
    this.markSet(w, this.markGet(w) === state ? "learning" : state)
    this.refreshMarks()
    this.moveCursor(1)
  }
  /**
   * 手动把游标所在的词加入错词本 —— 哪怕这题打对了。
   *
   * 走 onWrongWord 但带 `manual` 标记：路由侧据此带 `unmaster` 写库
   * （把已标「会了」的行拉回活跃，否则用户加了却看不见），并弹提示。
   *
   * 同步把这个词塞进 knownWrong：后面几句的填空立刻按「我曾经错过」加权。
   * 写完游标前进一格，跟 x/c 的手感一致。
   */
  addCursorToWB() {
    this.addSlotToWB(this.mkCursor)
  }
  /** 触屏端按词下标加入（点词 → 操作条），不依赖游标停在哪。 */
  addWordToWB(i: number) {
    this.addSlotToWB(this.slots.findIndex((sl) => sl.i === i))
  }
  private addSlotToWB(k: number) {
    const sl = this.slots[k]
    if (!sl) return
    const w = bare(sl.w.w)
    const nz = this.wordNormOf(w)
    if (!nz) return
    this.knownWrong.add(nz)
    this.onWrongWord?.(
      {
        lessonId: this.lessonId,
        wordNorm: nz,
        display: w,
        audioUrl: this.audioUrl,
        startMs: Math.round(sl.w.s * 1000),
        endMs: Math.round(sl.w.e * 1000),
      },
      "manual",
    )
    this.moveCursor(1)
    this.bump()
  }
  /** 手机点答案区的词：循环切换 learning → 会了 → 忽略 → learning（桌面 j/k + x/c 的等价物） */
  markCursorCycle(i: number) {
    const k = this.slots.findIndex((sl) => sl.i === i)
    if (k < 0) return
    const sl = this.slots[k]
    if (this.slotKind(sl) === "ok") return
    const w = bare(sl.w.w)
    const order = ["learning", "known", "ignore"]
    const next = order[(order.indexOf(this.markGet(w)) + 1) % order.length]
    this.markSet(w, next)
    this.mkCursor = k
    this.refreshMarks()
  }
  /**
   * 触屏端专用的直接标注：点某个词 → 操作条上选「会了 / 忽略 / 加入错词本」。
   *
   * 桌面端走 `markCursorCycle`（点一下在 会了→忽略→无 之间转圈）—— 那个在触屏上
   * 完全没有可发现性（没人知道点第二下会变成什么）。这里把状态显式传进来。
   * 顺手把 mkCursor 挪到这一格，好让 addCursorToWB() 跟上。
   */
  markWordAt(i: number, state: string) {
    const k = this.slots.findIndex((sl) => sl.i === i)
    if (k < 0) return
    const w = bare(this.slots[k].w.w)
    this.markSet(w, this.markGet(w) === state ? "learning" : state)
    this.mkCursor = k
    this.refreshMarks()
  }
  refreshMarks() {
    this.slots.forEach((s) => {
      s.cands = null
    })
    if (this.finished) this.renderAnswer()
    this.bump()
  }
  finishSentence() {
    if (this.finished) return
    this.finished = true
    this.stopLoop()
    this.clearCand()
    const total = this.slots.length
    let candN = 0
    let clean = true
    const counts: Record<string, number> = {}
    const noise: { kind: string; typed: string; target: string }[] = []
    this.slots.forEach((sl) => {
      const kind = this.slotKind(sl)
      counts[kind] = (counts[kind] || 0) + 1
      if (sl.usedCand) candN++
      if (kind !== "ok") clean = false
      else if (sl.everWrong || sl.usedCand) clean = false
      if (kind === "手滑" || kind === "漏尾" || kind === "多尾")
        noise.push({ typed: sl.value, target: bare(sl.w.w), kind })
      if (
        kind === "听错" ||
        kind === "留空" ||
        kind === "漏尾" ||
        kind === "多尾" ||
        sl.everWrong ||
        sl.state === "wrong" ||
        sl.state === "wrongFinal" ||
        sl.state === "reveal"
      ) {
        // 通过回调写库 —— 引擎自身不动网络，避免在这里 await 阻塞结算。
        // 路由侧用 trpc.wb.record.mutate，失败静默吞（再错一次就补回）。
        const wz = this.wordNormOf(sl.w.w)
        if (wz && this.onWrongWord) {
          this.onWrongWord(
            {
              lessonId: this.lessonId,
              wordNorm: wz,
              display: bare(sl.w.w),
              audioUrl: this.audioUrl,
              startMs: Math.round(sl.w.s * 1000),
              endMs: Math.round(sl.w.e * 1000),
            },
            "auto",
          )
        }
      }
    })
    TERMS.forEach((k) => {
      if (counts[k]) this.session!.types[k] = (this.session!.types[k] || 0) + 1
    })
    const okN = counts["ok"] || 0
    const typoN = counts["手滑"] || 0
    const unsureN = counts["存疑"] || 0
    const badN = counts["听错"] || 0
    const skipN = counts["留空"] || 0
    const good =
      okN +
      typoN +
      unsureN +
      (counts["漏尾"] || 0) +
      (counts["多尾"] || 0)
    const sec = (Date.now() - this.session!.sentStart) / 1000
    this.session!.slots += total
    this.session!.good += good
    this.session!.listens += this.tries
    this.session!.log.push({ n: this.idx + 1, sec, listens: this.tries, kinds: { ...counts } })
    this.sessionGood += good
    this.sessionSlots += total

    let tierMsg = ""
    if (clean) {
      this.streak++
      this.missStreak = 0
      if (this.streak >= 2) {
        if (this.tierUp()) tierMsg = `升档 → ${TIERS[this.tier].name}`
        this.streak = 0
      }
    } else {
      this.streak = 0
      this.missStreak++
      if (this.missStreak >= 2) {
        if (this.tierDown()) tierMsg = `降档 → ${TIERS[this.tier].name}`
        this.missStreak = 0
      }
    }

    this.mkCursor = Math.max(0, this.slots.indexOf(this.markableSlots()[0]))
    this.renderAnswer()
    this.lastCounts = counts
    this.lastTierDir = tierMsg.indexOf("升") >= 0 ? 1 : -1
    this.verdict =
      badN === 0 && skipN === 0
        ? typoN || unsureN || counts["漏尾"] || counts["多尾"]
          ? "空位全对（含手滑/存疑）"
          : "全对"
        : `空位 ${total} 个 · 错 ${badN} 个` + (skipN ? ` · 留空 ${skipN} 个` : "")
    this.noiseList = noise
    this.meta =
      `${this.idx + 1} / ${this.sentences.length}  ·  空位正确率 ` +
      (this.sessionSlots ? Math.round((this.sessionGood / this.sessionSlots) * 100) : 0) + "%"
    this.bump()
  }
  tierUp(): boolean {
    if (this.tier >= TIERS.length - 1) return false
    this.tier++
    lsSet(TIER_KEY, String(this.tier))
    return true
  }
  tierDown(): boolean {
    if (this.tier <= 0) return false
    this.tier--
    lsSet(TIER_KEY, String(this.tier))
    return true
  }

  /* ---------- 报表 ---------- */
  reportRows() {
    const st = this.session!.types
    const maxN = Math.max(1, ...TERMS.map((k) => st[k] || 0))
    return TERMS.filter((k) => st[k]).map((k) => ({
      k,
      n: st[k],
      scored: SCORED[k],
      w: Math.max(3, Math.round((st[k] / maxN) * 130)),
    }))
  }
  topKind(): { k: string; n: number } {
    const st = this.session!.types
    let best = "",
      n = 0
    TERMS.forEach((k) => {
      if ((st[k] || 0) > n) {
        best = k
        n = st[k]
      }
    })
    return { k: best, n }
  }
  /**
   * 结算后根据正确率给出档位建议；不自动改档。
   * 发起入口统一是长按空格的命令层（有建议时层里才有 y/n），不直接吃键。
   */
  tierSuggestion: { from: number; to: number; acc: number } | null = null

  private suggestTierBy(acc: number) {
    if (acc >= TIER_UP_ACC && this.tier < MAX_TIER) {
      this.tierSuggestion = { from: this.tier, to: this.tier + 1, acc }
    } else if (acc < TIER_DOWN_ACC && this.tier > 0) {
      this.tierSuggestion = { from: this.tier, to: this.tier - 1, acc }
    } else {
      this.tierSuggestion = null
    }
  }
  applyTierSuggestion() {
    const s = this.tierSuggestion
    if (!s) return
    this.tier = s.to
    lsSet(TIER_KEY, String(s.to))
    this.tierSuggestion = null
    this.bump()
  }
  dismissTierSuggestion() {
    if (!this.tierSuggestion) return
    this.tierSuggestion = null
    this.bump()
  }

  finishSession() {
    this.over = true
    this.stopLoop()
    this.clearCheckpoint()
    if (!this.session) {
      this.session = {
        start: Date.now(),
        sentStart: Date.now(),
        slots: 0,
        good: 0,
        listens: 0,
        types: {},
        log: [],
      }
    }
    const elapsed = (Date.now() - this.session!.start) / 1000
    const acc = this.sessionSlots ? Math.round((this.sessionGood / this.sessionSlots) * 100) : 0
    this.suggestTierBy(acc)
    const rows = this.reportRows()
    const top = this.topKind()
    const n = this.session!.log.length
    const firstHalf = this.session!.log.slice(0, Math.floor(n / 2))
    const lastHalf = this.session!.log.slice(Math.floor(n / 2))
    const avg = (a: { sec: number }[]) => (a.length ? Math.round(a.reduce((s, x) => s + x.sec, 0) / a.length) : 0)
    const trend =
      n >= 4 && firstHalf.length && lastHalf.length
        ? `<br>前半程平均 <b>${avg(firstHalf)}s</b>/句 → 后半程 <b>${avg(lastHalf)}s</b>/句` +
          (avg(lastHalf) < avg(firstHalf) ? "（在变快）" : "（变慢了，多半是档位升了）")
        : ""
    const listens = this.session!.listens
    const slow = this.session!.log.slice().sort((a, b) => b.sec - a.sec)[0]
    const dose =
      (elapsed >= DOSE_SEC
        ? `本轮 <b>${mmss(elapsed)}</b>，够了（每日剂量 ${Math.round(DOSE_SEC / 60)} 分钟）`
        : `本轮 <b>${mmss(elapsed)}</b>，离 ${Math.round(DOSE_SEC / 60)} 分钟剂量还差 <b>${mmss(DOSE_SEC - elapsed)}</b>`) +
      ` · 平均每句 <b>${avg(this.session!.log)}s</b> · 累计听 <b>${listens}</b> 次` +
      (slow
        ? `<br>最慢的一句：第 <b>${slow.n}</b> 句，<b>${Math.round(slow.sec)}s</b> / 听 ${slow.listens} 次`
        : "")
    this.summary = {
      acc,
      n,
      totalSlots: this.sessionSlots,
      elapsed,
      rows,
      top,
      trend,
      dose,
    }
    // 进度回写
    if (this.onSave) {
      this.onSave({
        lessonId: this.lessonId,
        score: acc,
        accuracy: acc,
        durationSec: Math.round(elapsed),
        details: {
          slotAccuracy: acc,
          totalSlots: this.sessionSlots,
          types: this.session!.types,
          log: this.session!.log,
          tier: this.tier,
        },
      })
    }
    this.bump()
  }
  restartRound() {
    if (!this.sentences.length) return
    this.over = false
    this.idx = 0
    this.sessionGood = 0
    this.sessionSlots = 0
    this.streak = 0
    this.missStreak = 0
    this.noiseOpen = false
    this.summary = null
    // 上一轮没处理的档位建议不能带进新一轮：否则它会以看不见的方式还挂在那里
    this.tierSuggestion = null
    this.session = {
      start: Date.now(),
      sentStart: Date.now(),
      slots: 0,
      good: 0,
      listens: 0,
      types: {},
      log: [],
    }
    this.bump()
    this.loadSentence()
  }
  nextSentence() {
    this.idx++
    if (this.idx >= this.sentences.length) {
      this.finishSession()
      return
    }
    this.loadSentence()
  }
  prevSentence() {
    if (this.idx > 0) this.gotoIdx(this.idx - 1)
  }
  restartSentence() {
    this.loadSentence()
  }

  /* ---------- 命令层（长按空格） ---------- */
  layerTable(): LayerCmd[] {
    if (this.finished) {
      const done: LayerCmd[] = this.over
        ? [
            { k: "d", label: "再来一轮", fn: () => this.restartRound() },
            // 档位建议走长按空格的命令层发起：有建议才出现这两个键，
            // 接受/忽略后建议清空，下次长按空格时它们自然消失。
            ...(this.tierSuggestion
              ? [
                  {
                    k: "y",
                    label:
                      (this.tierSuggestion.to > this.tierSuggestion.from
                        ? "升档到 "
                        : "降档到 ") +
                      TIERS[this.tierSuggestion.to].name,
                    fn: () => this.applyTierSuggestion(),
                  },
                  { k: "n", label: "忽略建议", fn: () => this.dismissTierSuggestion() },
                ]
              : []),
          ]
        : [
            { k: "j", label: "上一个", fn: () => this.moveCursor(-1) },
            { k: "k", label: "下一个", fn: () => this.moveCursor(1) },
            { k: "a", label: "加入错词本", fn: () => this.addCursorToWB() },
            { k: "x", label: "我会了", fn: () => this.markCursor("known") },
            { k: "c", label: "忽略", fn: () => this.markCursor("ignore") },
            { k: "d", label: "下一句", fn: () => this.nextSentence() },
            { k: "r", label: "重来本句", fn: () => this.restartSentence() },
            { k: "b", label: "明细", fn: () => this.toggleNoise() },
          ]
      return done.concat([{ k: BACK, label: "返回" }])
    }
    const segs = this.cands || !this.cur() ? 0 : this.segmentsOf(this.cur()!).length
    const base: LayerCmd[] =
      segs < 2
        ? this.layerTyping()
        : this.layerTyping().concat(
            Array.from({ length: segs }, (_, i) => ({
              k: String(i + 1),
              label: `第 ${i + 1} 段`,
              fn: () => this.playSegment(i),
            })),
          )
    return base.concat([{ k: BACK, label: "返回" }])
  }
  private layerTyping(): { k: string; label: string; fn: () => void }[] {
    return [
      { k: "w", label: "重听本词", fn: () => this.playSlotWord() },
      { k: "e", label: "慢速重播", fn: () => this.playCurrent(undefined, 0.6) },
      { k: "s", label: "候选词", fn: () => this.toggleCand() },
      { k: "d", label: "校验前进", fn: () => this.checkAndAdvance() },
      { k: "f", label: "留空跳过", fn: () => this.skipSlot() },
      { k: "a", label: "看答案", fn: () => this.revealAll() },
      { k: "r", label: "重来本句", fn: () => this.restartSentence() },
      { k: "n", label: "上一句", fn: () => this.prevSentence() },
      {
        k: "l",
        label: `循环重播 ${this.loopOn ? "开" : "关"}`,
        fn: () => this.toggleLoop(),
      },
    ]
  }
  showLayer() {
    const items = this.layerTable()
    this.layerItems = items.map(({ k, label }) => ({ k, label }))
    this.layerOpen = true
    this.bump()
  }
  hideLayer() {
    this.layerOpen = false
    this.layerItems = []
    this.bump()
  }
  back() {
    if (this.cands) {
      this.clearCand()
    }
    this.spaceHeld = false
    this.spaceHit = true
    this.hideLayer()
  }
  runLayer(k: string) {
    if (k === BACK) {
      this.back()
      return
    }
    const fn = this.layerTable().find((x) => x.k === k)?.fn
    if (fn) fn()
    this.showLayer()
  }

  /* 全局 keydown。返回是否处理，组件用 preventDefault。 */
  handleKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return
    if (e.metaKey || e.ctrlKey) return
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === "SELECT" || tag === "TEXTAREA") return
    if (this.gateOpen) {
      e.preventDefault()
      this.unlock()
      this.closeGate()
      if (this.cur()) this.playCurrent(false)
      return
    }
    if (!this.sentences.length) return

    if (this.finished) {
      if (e.key === " ") {
        e.preventDefault()
        if (e.repeat || this.spaceHeld) return
        this.spaceHeld = true
        this.spaceHit = false
        this.showLayer()
        return
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : ""
      if (!k) return
      if (this.spaceHeld) {
        e.preventDefault()
        if (e.repeat) return
        if (!this.layerItems.some((x) => x.k === k)) {
          this.back()
          return
        }
        this.spaceHit = true
        this.runLayer(k)
        return
      }
      // over 态不再直接吃 y/n —— 档位建议统一走长按空格的命令层发起，
      // 免得"有建议时 y 有效、没建议时 y 无效"变成看不见的模式。
      const acts: Record<string, () => void> = this.over
        ? {
            d: () => this.restartRound(),
          }
        : {
            d: () => this.nextSentence(),
            j: () => this.moveCursor(-1),
            k: () => this.moveCursor(1),
            a: () => this.addCursorToWB(),
            x: () => this.markCursor("known"),
            c: () => this.markCursor("ignore"),
            r: () => this.restartSentence(),
            b: () => this.toggleNoise(),
          }
      if ((acts as Record<string, () => void>)[k]) {
        e.preventDefault()
        this.spaceHit = true
        ;(acts as Record<string, () => void>)[k]()
      }
      return
    }

    if (e.key === " ") {
      e.preventDefault()
      if (e.repeat || this.spaceHeld) return
      this.spaceHeld = true
      this.spaceHit = false
      this.showLayer()
      return
    }
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"].includes(e.key)) return

    if (this.cands && !e.repeat && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      this.spaceHit = true
      this.pickCand(parseInt(e.key, 10) - 1)
      if (this.spaceHeld) this.showLayer()
      return
    }
    if (this.cands && e.key === "Escape") {
      e.preventDefault()
      this.clearCand()
      this.updateStatus()
      return
    }

    if (this.spaceHeld) {
      e.preventDefault()
      if (e.repeat) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : ""
      if (!k || !this.layerItems.some((x) => x.k === k)) {
        this.back()
        return
      }
      this.spaceHit = true
      this.runLayer(k)
      return
    }

    if (!this.inSlot()) {
      if (e.key.length === 1 && !e.altKey) {
        const sl = this.refocus()
        // 触屏端没有词槽 input（inputRefs 为空）——refocus 只会移动 slotIdx，
        // 这里必须判空，否则对 undefined 取 .value 直接抛。
        const j = sl ? this.slots.indexOf(sl) : -1
        const el = j >= 0 ? this.inputRefs.get(j) : undefined
        if (el) {
          e.preventDefault()
          el.value = String(el.value || "") + e.key
          this.onSlotInput(j, el.value)
        }
      }
      return
    }
  }
  handleKeyUp(e: KeyboardEvent) {
    if (e.key !== " ") return
    const wasHeld = this.spaceHeld
    this.spaceHeld = false
    this.hideLayer()
    if (!wasHeld || this.spaceHit) return
    if (this.gateOpen || !this.sentences.length) return
    this.playCurrent()
  }
  handleBlur() {
    this.spaceHeld = false
    this.spaceHit = false
    this.hideLayer()
  }
}

export function usePractice(
  onSave?: (p: AttemptPayload) => void,
  onWrongWord?: (row: WrongWordRecord, source?: "auto" | "manual") => void,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /* 引擎是"改自己字段 + bump() 通知"的可变对象。这里必须用
     useSyncExternalStore，不能写 const [, setVer] = useState(0)：
     一个从来没人读的 state，React 编译器会当成不参与渲染的依赖，
     更新随时可能被优化掉 —— 起播门点了不关就是这个来的。 */
  const storeRef = useRef<{ ver: number; ls: Set<() => void> } | null>(null)
  if (!storeRef.current) storeRef.current = { ver: 0, ls: new Set() }
  const store = storeRef.current
  const subscribe = useCallback(
    (cb: () => void) => {
      store.ls.add(cb)
      return () => {
        store.ls.delete(cb)
      }
    },
    [store],
  )
  const getSnapshot = useCallback(() => store.ver, [store])
  const getServerSnapshot = useCallback(() => 0, [])
  const ver = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const bump = useCallback(() => {
    store.ver++
    store.ls.forEach((cb) => cb())
  }, [store])
  const engineRef = useRef<PracticeEngine | null>(null)
  if (!engineRef.current)
    engineRef.current = new PracticeEngine(audioRef, bump, onSave, onWrongWord)
  // 回调可能在后续渲染变化，每次同步给引擎（避免锁住旧引用）
  engineRef.current.onSave = onSave
  engineRef.current.onWrongWord = onWrongWord
  const engine = engineRef.current

  useEffect(() => {
    const ek = (e: KeyboardEvent) => engine.handleKeyDown(e)
    const eu = (e: KeyboardEvent) => engine.handleKeyUp(e)
    const bl = () => engine.handleBlur()
    document.addEventListener("keydown", ek)
    document.addEventListener("keyup", eu)
    window.addEventListener("blur", bl)
    let raf = 0
    const loop = () => {
      engine.tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const clock = window.setInterval(() => {
      if (engine.session) {
        const el = (Date.now() - engine.session.start) / 1000
        engine.clockStr =
          mmss(el) + (el >= DOSE_SEC ? " ✓" : " / " + Math.round(DOSE_SEC / 60) + "分")
        engine.bump()
      }
    }, 1000)
    return () => {
      document.removeEventListener("keydown", ek)
      document.removeEventListener("keyup", eu)
      window.removeEventListener("blur", bl)
      cancelAnimationFrame(raf)
      clearInterval(clock)
    }
  }, [])

  return { engine, audioRef, ver }
}
