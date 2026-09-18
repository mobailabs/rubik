/* 引擎冒烟测试：在 Node 里跑真实的 PracticeEngine 类（不是另写一份逻辑），
   验证移植后的键盘状态机 / 判分 / 命令层 / 进度回写 payload 都和预期一致。
   运行：见 package 脚本或 esbuild 打包后用 node 跑。 */
import "./stub-globals"
import { DOCK_CLASS, PracticeEngine } from "./usePractice"
import { norm } from "./judge"

function fakeInput() {
  return {
    value: "",
    focus() {},
    select() {},
    setAttribute() {},
    classList: { add() {}, remove() {}, contains() { return false } },
    style: {},
  } as any
}

let saved: any = null
let wrongRows: any[] = []
const manualRows: any[] = []
const audioRef = { current: null as any }
const engine = new PracticeEngine(
  audioRef,
  () => {},
  (p) => {
    saved = p
  },
  (row, source) => {
    ;(source === "manual" ? manualRows : wrongRows).push(row)
  },
)

const content: any = {
  sentences: [
    {
      start: 0, end: 1, text: "What should we do next?",
      words: [
        { w: "What", s: 0, e: 0.2, p: 1 },
        { w: "should", s: 0.2, e: 0.4, p: 1 },
        { w: "we", s: 0.4, e: 0.5, p: 1 },
        { w: "do", s: 0.5, e: 0.6, p: 1 },
        { w: "next?", s: 0.6, e: 0.8, p: 1 },
      ], low_conf: [],
    },
    {
      start: 1, end: 2, text: "Where do we go from here?",
      words: [
        { w: "Where", s: 1, e: 1.2, p: 1 },
        { w: "do", s: 1.2, e: 1.3, p: 1 },
        { w: "we", s: 1.3, e: 1.4, p: 1 },
        { w: "go", s: 1.4, e: 1.5, p: 1 },
        { w: "from", s: 1.5, e: 1.6, p: 1 },
        { w: "here?", s: 1.6, e: 1.8, p: 1 },
      ], low_conf: [],
    },
  ],
}

let pass = 0, fail = 0
function t(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(want)}  实际 ${JSON.stringify(got)}`)
  ok ? pass++ : fail++
}

function key(k: string, opts: any = {}) {
  return {
    key: k, repeat: false, isComposing: false, keyCode: 0,
    metaKey: false, ctrlKey: false,
    target: { tagName: "INPUT", classList: { contains: () => false } },
    preventDefault() {}, ...opts,
  } as any
}

function load() {
  saved = null
  engine.loadLesson(content, "https://example.com/a.wav", "test_lesson", "Test")
  engine.slots.forEach((sl: any) => engine.registerInput(engine.slots.indexOf(sl), fakeInput()))
}

function typeInto(idx: number, text: string) {
  const el = engine.inputRefs.get(idx)
  el.value = ""
  for (const ch of text) { el.value += ch; engine.onSlotInput(idx, el.value) }
}

// 选一个确定是真英文词、且不等于目标的"听错"词
function wrongRealWord(target: string) {
  return target === "the" ? "and" : "the"
}

// ---------- 0) 兼容 DB 裸数组 content ----------
{
  const bare: any = (content as any).sentences // 模拟 DB 直接存句子数组
  saved = null
  engine.loadLesson(bare, "https://example.com/a.wav", "bare_lesson", "Bare")
  t("裸数组 content 也能载入句子", engine.sentences.length, bare.length)
}
// ---------- 1) 命令层（打字态）：长按空格开层，h 返回关层 ----------
load()
t("载入后未结算", engine.finished, false)
t("有空位（骨架档约 2 个）", engine.slots.length >= 1, true)
// 浏览器自动播放策略：首个按键先解锁音频门（gateOpen），不开层
engine.handleKeyDown(key(" "))
t("首次空格解锁音频门（gateOpen=false）", engine.gateOpen, false)
engine.handleKeyUp(key(" "))
// 门已开，再次长按空格 → 开命令层
engine.handleKeyDown(key(" "))
t("长按空格 → 命令层开", engine.layerOpen, true)
t("命令层含固定返回键 h", engine.layerItems.some((x: any) => x.k === "h"), true)
t("命令层含 w/e/s/d/f/a/r/n", ["w", "e", "s", "d", "f", "a", "r", "n"].every((k) => engine.layerItems.some((x: any) => x.k === k)), true)
engine.handleKeyDown(key("w")) // 重听本词：执行后层保持开
t("层命令 'w' 执行后层仍开", engine.layerOpen, true)
engine.handleKeyDown(key("h")) // 返回
t("按 h → 命令层关", engine.layerOpen, false)
engine.handleKeyUp(key(" "))
t("松开空格后 spaceHeld=false", engine.spaceHeld, false)

// ---------- 2) 全部正确 → 自动结算，全对 ----------
load()
const targetsAll = engine.slots.map((s: any) => s.n)
targetsAll.forEach((nz: string, i: number) => typeInto(i, nz))
t("全部正确 → 自动结算 finished", engine.finished, true)
t("所有空位状态 ok", engine.slots.every((s: any) => s.state === "ok"), true)
t("结算语含『全对』", engine.verdict.indexOf("全对") >= 0, true)

// ---------- 3) 含一个听错 → 计分，错词进错词本 ----------
load()
const targets = engine.slots.map((s: any) => s.n)
for (let i = 0; i < targets.length - 1; i++) typeInto(i, targets[i]) // 前 n-1 个打对
const lastIdx = targets.length - 1
typeInto(lastIdx, wrongRealWord(targets[lastIdx])) // 最后一个打成一个别的真词
t("打错后该槽仍为 empty/wrong（未自动判）", ["empty", "wrong"].includes(engine.slots[lastIdx].state), true)
engine.checkAndAdvance() // 第一次校验 → wrong
t("校验一次 → 状态 wrong", engine.slots[lastIdx].state, "wrong")
engine.checkAndAdvance() // 第二次校验 → wrongFinal → 自动结算
t("再校验 → 自动结算 finished", engine.finished, true)
t("报表含听错计数", (engine.lastCounts["听错"] || 0) >= 1, true)
const target = targets[lastIdx]
const match = wrongRows.find((r) => r.wordNorm === norm(target))
t("错词抛给 onWrongWord（归一化一致）", !!match, true)
if (match) {
  t("onWrongWord.display 含原词", typeof match.display === "string" && match.display.length > 0, true)
  t("onWrongWord.audioUrl 是字符串 URL", typeof match.audioUrl === "string" && match.audioUrl.startsWith("http"), true)
  t("onWrongWord.startMs / endMs 是整数", Number.isInteger(match.startMs) && Number.isInteger(match.endMs), true)
}

// ---------- 4) 命令层（结算态） ----------
engine.handleKeyDown(key(" "))
t("结算态命令层开", engine.layerOpen, true)
t("结算态命令层含 j/k/a/x/c/d/r/b", ["j", "k", "a", "x", "c", "d", "r", "b"].every((k) => engine.layerItems.some((x: any) => x.k === k)), true)
engine.handleKeyDown(key("h"))
t("结算态按 h → 关层", engine.layerOpen, false)
engine.handleKeyUp(key(" "))


// ---------- 5) 进度回写 payload（对齐 attempt.save 入参） ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  await sleep(1100)
  engine.finishSession()
  t("onSave 被调用", saved !== null, true)
  if (saved) {
    t("payload.lessonId", saved.lessonId, "test_lesson")
    t("payload.score 是 0-100 数字", typeof saved.score === "number" && saved.score >= 0 && saved.score <= 100, true)
    t("payload.durationSec 是数字且>0", typeof saved.durationSec === "number" && saved.durationSec > 0, true)
    t("payload.details.types 有内容", !!saved.details && !!saved.details.types && Object.keys(saved.details.types).length > 0, true)
    t("payload.details 含 tier", typeof saved.details.tier === "number", true)
    t("accuracy 与 score 一致", saved.accuracy === saved.score, true)
    t("summary.dose 含 平均每句", engine.summary!.dose.includes("平均每句"), true)
    t("summary.dose 含 累计听", engine.summary!.dose.includes("累计听"), true)
    t("summary.dose 含 最慢的一句（本轮仅1句）", engine.summary!.dose.includes("最慢的一句"), true)
  }

  // ---------- 6) 手动加入错词本：蒙对的词也要能加 ----------
  // 放最后：它会 load() 重置 session，而上面第 5 节的 payload 断言依赖第 3 节那次会话。
  load()
  const okTargets = engine.slots.map((s: any) => s.n)
  okTargets.forEach((nz: string, i: number) => typeInto(i, nz))
  t("手动加入场景：全部空位 ok（模拟蒙对）", engine.slots.every((s: any) => s.state === "ok"), true)
  manualRows.length = 0
  const firstWord = engine.slots[0].w.w
  engine.mkCursor = 0
  engine.addCursorToWB()
  t("蒙对的词也能手动加入（抛 1 条 manual）", manualRows.length, 1)
  t("手动加入的 wordNorm 归一正确", manualRows[0]?.wordNorm, engine.wordNormOf(firstWord))
  t("手动加入的 display 是裸词", manualRows[0]?.display, firstWord.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ""))
  t("手动加入同步进 knownWrong（后续填空加权）", engine.inWrongBook(firstWord), true)
  t("手动加入后游标前进一格", engine.mkCursor, engine.slots.length > 1 ? 1 : 0)
  // 游标覆盖全部空位，而不只是错的 —— 否则蒙对的词选不中
  const seen = new Set<number>()
  for (let i = 0; i < engine.slots.length; i++) {
    seen.add(engine.mkCursor)
    engine.moveCursor(1)
  }
  t("j/k 游标能走遍全部空位（含蒙对的）", seen.size, engine.slots.length)

  // ---------- 7) 档位建议走长按空格的命令层 ----------
  load()
  engine.finished = true
  engine.over = true
  engine.tierSuggestion = { from: 1, to: 0, acc: 60 }
  engine.handleKeyDown(key(" "))
  t("有建议时 over 层含 y/n", ["y", "n"].every((k) => engine.layerItems.some((x: any) => x.k === k)), true)
  t("层里 y 标签带目标档位名", engine.layerItems.some((x: any) => x.k === "y" && x.label.indexOf("热身") >= 0), true)
  engine.handleKeyDown(key("y")) // 层内按 y → runLayer 执行接受
  t("层里按 y → 档位落到建议档", engine.tier, 0)
  t("接受后建议清空", engine.tierSuggestion, null)
  t("建议消失后 y/n 不在层里", ["y", "n"].some((k) => engine.layerItems.some((x: any) => x.k === k)), false)
  engine.handleKeyDown(key("h"))
  engine.handleKeyUp(key(" "))

  // ---------- 8) 触屏端：单输入答题条（底部 dock） ----------
  // 这一节全放在最后：它会把 inputRefs 清空来模拟"触屏端没有词槽 input"。
  load()
  t("DOCK_CLASS 和答题条的 class 一致", DOCK_CLASS, "dock-input")
  t("activeSlotIndex 指向第一个空位", engine.activeSlotIndex(), 0)

  // 焦点在答题条里 → inSlot() 必须为真。为假的话引擎会接管答题条的每个按键
  // （走"打字自动拉回词槽"那条老路），而触屏端没有词槽 input。
  ;(globalThis as any).document.activeElement = {
    tagName: "INPUT",
    classList: { contains: (c: string) => c === DOCK_CLASS, add() {}, remove() {} },
  }
  t("焦点在答题条里时 inSlot() 为真", engine.inSlot(), true)
  // 焦点在按钮上（刚点过工具条）→ 走回退分支，而且必须不抛：
  // 触屏端 inputRefs 是空的，老代码对 undefined 取 .value 会 TypeError。
  ;(globalThis as any).document.activeElement = {
    tagName: "BUTTON",
    classList: { contains: () => false, add() {}, remove() {} },
  }
  engine.inputRefs = new Map()
  const beforeVals = engine.slots.map((s: any) => s.value).join("|")
  let threw = false
  try {
    engine.handleKeyDown(key("q"))
  } catch {
    threw = true
  }
  t("触屏无词槽 input 时打字回退不抛错", threw, false)
  t("回退分支不往任何词槽里塞字符", engine.slots.map((s: any) => s.value).join("|"), beforeVals)
  ;(globalThis as any).document.activeElement = null

  // selectSlot：只有还能填的格可以被选中
  load()
  t("selectSlot 选中空位", engine.selectSlot(1), true)
  t("selectSlot 更新 slotIdx", engine.slotIdx, 1)
  typeInto(1, engine.slots[1].n)
  t("填对后自动前进", engine.slotIdx >= 0 && engine.slots[1].state, "ok")
  t("selectSlot 拒绝已完成的格", engine.selectSlot(1), false)

  // markWordAt：显式三态（触屏的"点词弹操作条"），同一态再点 = 清除
  const wi0 = engine.slots[0].i
  const w0 = engine.slots[0].w.w
  engine.markWordAt(wi0, "known")
  t("markWordAt known 生效", engine.markGet(w0), "known")
  t("markWordAt 把游标挪到该词", engine.mkCursor, 0)
  engine.markWordAt(wi0, "known")
  t("同一态再点一次 = 清除", engine.markGet(w0), "learning")

  // addWordToWB：按词下标加，不依赖游标停在哪
  manualRows.length = 0
  engine.mkCursor = 0
  const lastK = engine.slots.length - 1
  const wi3 = engine.slots[lastK].i
  const w3 = engine.slots[lastK].w.w
  engine.addWordToWB(wi3)
  t("addWordToWB 抛 1 条 manual", manualRows.length, 1)
  t("addWordToWB 加的是指定词而不是游标词", manualRows[0]?.wordNorm, engine.wordNormOf(w3))

  console.log(`\n共 ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
