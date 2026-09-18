/* Parity test: 把 english-typing/test_judge.js 的核心断言搬到新的纯 TS judge.ts。
   标记类（markGet/markSet/known/ignore）已移入引擎层（usePractice），这里只验判分层。
   运行：node --experimental-strip-types apps/web/src/lib/engine/judge-parity.ts */
import {
  wordVerdict, isTransposition, lev, norm, bare, expandWord,
  blankTargets, TIERS, COMMON, distractorsFor, endingKind,
} from "./judge.ts"

// 用真实课程数据驱动空位/干扰项断言（与旧测试一致）
import { readFileSync } from "node:fs"
import { join } from "node:path"

const LESSON_DIR = "/Users/zhaopeng/WorkBuddy/2026-09-10-17-22-30/english-typing/lessons"
// 找第一个 lesson json（顺序读 index.json）
let S: any[] = []
try {
  const idx = JSON.parse(readFileSync(join(LESSON_DIR, "index.json"), "utf8"))
  if (idx.length) S = JSON.parse(readFileSync(join(LESSON_DIR, idx[0].file), "utf8")).sentences
} catch {
  // 没有课程数据就跳过依赖真实句子的断言
}

let pass = 0, fail = 0
function t(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(want)}  实际 ${JSON.stringify(got)}`)
  ok ? pass++ : fail++
}

console.log("— 单词判定：打出来不是词 = 手滑，放行且不计分 —")
t("完全一致", wordVerdict("should", "should"), "ok")
t("忽略大小写与标点", wordVerdict("should", "Should,"), "ok")
t("漏一个字母 shold", wordVerdict("should", "shold"), "typo")
t("多一个字母 nexxt", wordVerdict("next", "nexxt"), "typo")
t("相邻换位 shoudl", wordVerdict("should", "shoudl"), "typo")
t("相邻换位 wroking", wordVerdict("working", "wroking"), "typo")
t("同长度拼错 seperate", wordVerdict("separate", "seperate"), "typo")
t("同长度拼错 importent", wordVerdict("important", "importent"), "typo")
t("换位式拼错 recieve", wordVerdict("receive", "recieve"), "typo")
t("换位判定本身", [isTransposition("should", "shoudl"), isTransposition("should", "shold")], [true, false])

console.log("\n— 单词判定：写出了一个别的真词 = 听错，计分 —")
t("what → that", wordVerdict("what", "that"), "error")
t("next → text", wordVerdict("next", "text"), "error")
t("working → wording", wordVerdict("working", "wording"), "error")
t("完全听错", wordVerdict("should", "nothing"), "error")
t("空输入", wordVerdict("should", ""), "error")
t("now → no", wordVerdict("now", "no"), "error")
t("then → the", wordVerdict("then", "the"), "error")
t("think → thin", wordVerdict("think", "thin"), "error")
t("world → word", wordVerdict("world", "word"), "error")
t("start → star", wordVerdict("start", "star"), "error")
t("hear → her", wordVerdict("hear", "her"), "error")

console.log("\n— 词表完整性 —")
const ESSENTIAL = ["is", "are", "was", "were", "been", "being", "am", "the", "then", "than", "that",
  "no", "now", "word", "world", "text", "thin", "star", "her", "here", "hear",
  "working", "wording", "empty", "had", "beside", "anymore", "weeks", "worst", "does", "did"]
t("常用词一个都不能缺", ESSENTIAL.filter((w) => !COMMON.has(w)), [])
t("表里没有粘连产生的垃圾词", [...COMMON].filter((w) => w.length > 15), [])
t("表里都是纯小写字母", [...COMMON].filter((w) => !/^[a-z]+$/.test(w)), [])

console.log("\n— 存疑：ASR 自己不确定的词，不罚 —")
t("Everything(p=0.616) 漏字母", wordVerdict("everything", "everythin", 0.616), "unsure")
t("Everything(p=0.616) 打成别的词", wordVerdict("everything", "anything", 0.616), "unsure")
t("Everything(p=0.616) 打对", wordVerdict("everything", "everything", 0.616), "ok")
t("高置信度词不吃豁免", wordVerdict("working", "wording", 0.99), "error")

console.log("\n— 缩写与标点容错 —")
t("目标 What's，打 What's", wordVerdict(norm("What's"), "What's"), "ok")
t("目标 What's，打 whats", wordVerdict(norm("What's"), "whats"), "ok")
t("带句号的词条能被 norm 削掉", norm("now."), "now")
t("bare 去掉首尾标点", [bare("next?"), bare("What's"), bare("working")], ["next", "What's", "working"])
t("don't 展开成 do not", expandWord("don't"), ["do", "not"])
t("课文 do，你打 don't → 算对", wordVerdict("do", "don't"), "ok")
t("课文 not，你打 don't → 算对", wordVerdict("not", "don't"), "ok")
t("课文 is，你打 it's → 算对", wordVerdict("is", "it's"), "ok")
t("但目标不是那个词时不算对（dog ← don't）", wordVerdict("dog", "don't") === "ok", false)

console.log("\n— 编辑距离自检 —")
;[["shoudl", "should", 1], ["working", "wording", 1], ["next", "text", 1], ["should", "cat", 9]]
  .forEach(([a, b, e]) => t(`lev(${a},${b}) = ${e}`, lev(a as string, b as string), e))

if (S.length) {
  console.log("\n— 空位挑选：四档比例 × 真实课程数据 —")
  const wbNone = new Set<string>()
  TIERS.forEach((T, ti) => {
    let allOk = true
    const detail: string[] = []
    S.forEach((s: any) => {
      const plan = blankTargets(s.words, T.ratio, { wrongSet: wbNone })
      const uniq = new Set(s.words.map((w: any) => norm(w.w)).filter(Boolean)).size
      const want = Math.min(Math.max(1, Math.round(s.words.length * T.ratio)), uniq)
      if (plan.length !== want) allOk = false
      detail.push(`${s.words.length}词→${plan.length}空`)
    })
    console.log(`${allOk ? "PASS" : "FAIL"}  ${T.name}(比例 ${T.ratio})  ${detail.slice(0, 5).join(" ")} ...`)
    allOk ? pass++ : fail++
  })

  console.log("\n— 比例必须在长句上站得住 —")
  TIERS.forEach((T) => {
    const fake = { words: Array.from({ length: 20 }, (_, i) => ({ w: "blahblah" + i })) }
    const got = blankTargets(fake.words, T.ratio, { wrongSet: wbNone }).length
    const want = Math.round(20 * T.ratio)
    t(`20 词句 · ${T.name} 应空 ${want} 个`, got, want)
  })

  console.log("\n— 空位挑选规则 —")
  const s0 = S[0]
  const p0 = blankTargets(s0.words, TIERS[1].ratio, { wrongSet: wbNone })
  t("空位下标递增", p0.every((v: number, i: number, a: number[]) => i === 0 || v > a[i - 1]), true)
  t("空位不重复", new Set(p0).size, p0.length)
  t("空位落在词数范围内", p0.every((v: number) => v >= 0 && v < s0.words.length), true)

  console.log("\n— 错词本优先 —")
  t("well 被空出来（档位1 只有 2 个空）", blankTargets(s0.words, TIERS[1].ratio, { wrongSet: new Set(["well"]) }).indexOf(3) >= 0, true)
  t("两个错词都空出来", blankTargets(s0.words, TIERS[1].ratio, { wrongSet: new Set(["well", "everything"]) }).sort((a: number, b: number) => a - b), [0, 3])

  console.log("\n— 干扰项：答案在列表里，但位置必须会变 —")
  let candOk = true, candSample = ""
  S.slice(0, 5).forEach((s: any) => s.words.forEach((w: any) => {
    const list = distractorsFor(w.w, [])
    const nz = norm(w.w)
    if (list.indexOf(nz) < 0 || list.length < 2 || new Set(list).size !== list.length) candOk = false
    if (!candSample) candSample = nz + " → " + list.join("/")
  }))
  t("答案一定在候选里，且不重复", candOk, true)
  console.log(`      示例: ${candSample}`)

  const posHits: Record<number, number> = {}
  for (let i = 0; i < 80; i++) {
    const list = distractorsFor("working", [])
    const pos = list.indexOf("working") + 1
    posHits[pos] = (posHits[pos] || 0) + 1
  }
  t("连抽 80 次，答案落点不止一种", Object.keys(posHits).length > 1, true)
  t("四个位置都出现过", Object.keys(posHits).sort().join(""), "1234")
  console.log(`      落点分布: ${JSON.stringify(posHits)}`)

  console.log("\n— 干扰项：弱读词也得有像样的近音项 —")
  t("is 的候选里有 his / as", ["his", "as"].some((x) => distractorsFor("is", []).indexOf(x) >= 0), true)
  t("are 的候选里有 our", distractorsFor("are", []).indexOf("our") >= 0, true)
  t("the 的候选里有 they 或 a", ["they", "a"].some((x) => distractorsFor("the", []).indexOf(x) >= 0), true)
  t("of 的候选里有 have", distractorsFor("of", []).indexOf("have") >= 0, true)
}

console.log("\n— 漏尾音 —")
t("next → nex 是漏尾", endingKind("next", "nex"), "漏尾")
t("working → workin 是漏尾", endingKind("working", "workin"), "漏尾")
t("days → day 不走漏尾", endingKind("days", "day"), "")
t("days → day 的判定本身就是 error", wordVerdict("days", "day"), "error")
t("days → dayss 是多尾", endingKind("days", "dayss"), "多尾")
t("next → nextt 是多尾", endingKind("next", "nextt"), "多尾")
t("now → no 不是漏尾", endingKind("now", "no"), "")
t("中段漏字母不算漏尾", endingKind("working", "wrking"), "")
t("毫不相关的两串不算漏尾", endingKind("should", "zzzz"), "")
t("空输入不算漏尾", endingKind("next", ""), "")

console.log(`\n共 ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
