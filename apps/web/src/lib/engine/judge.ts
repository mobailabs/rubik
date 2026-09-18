/* 纯逻辑层：打字判分 / 空位挑选 / 近音干扰项。
   不碰 DOM、不碰 localStorage，全部输入进、结果出 —— 这样能单测，
   也和 english-typing/index.html 里的实现 1:1 对齐（test_judge.js 的断言对象）。

   移植自 english-typing/index.html，键盘模型与判分规则一条不改：
   - 判据只有一条：你打出来的那串是不是一个真英文词。不是词→手滑放行；是真词→听错计分。
   - ASR 置信度低于 CONF_FLOOR → 存疑，放行不计分。
   - ok / typo / unsure 放行，只有 error 计分。 */

export const CONF_FLOOR = 0.85

export const WB_KEY = "et_wrongbook_v1"
export const TIER_KEY = "et_tier_v1"
export const MARK_KEY = "et_wordmark_v1"

/* ---------- 常见词：分辨"手滑"和"听错"的唯一判据 ---------- */
const COMMON_A = `a able about above accept according account across act action activity actually add address administration admit adult affect after again against age agency agent ago agree agreement ahead air all allow almost alone along already also although always american among amount analysis and animal another answer any anybody anyone anything appear apply approach area argue arm army around arrive art article artist as ask assume at attack attention attorney audience author authority available avoid away baby back bad bag ball bank bar base be beat beautiful because become bed before begin behavior behind believe benefit best better between beyond big bill billion bit black blood blue board body book born both box boy break bring brother budget build building business busy but buy by call camera campaign can cancer candidate capital car card care career carry case catch cause cell center central century certain certainly chair challenge chance change character charge check child choice choose church citizen city civil claim class clear clearly close coach cold collection college color come commercial common community company compare computer concern condition conference congress consider consumer contain continue control cook cool cost could country couple course court cover create crime cultural culture cup current customer cut dark data daughter day dead deal death debate decade decide decision deep defense degree democratic describe design despite detail determine develop development die difference different difficult dinner direction director discover discuss discussion disease do doctor dog door down draw dream drive drop drug during each early east easy eat economic economy edge education effect effort eight either election else employee end energy enjoy enough enter entire environment especially establish even evening event ever every everybody everyone everything evidence exactly example executive exist expect experience expert explain eye face factor fail fall family far fast father fear federal feel feeling field fight figure fill film final finally financial find fine finger finish fire firm first fish five floor fly focus follow food foot force foreign forget form former forward four free friend from front full fund future game garden general generation get girl give glass go goal good government great green ground group grow growth guess gun guy hair half hand hang happen happy hard have he head health hear heart heat heavy help her here herself high him himself his history hit hold home hope hospital hot hotel hour house how however huge human hundred husband i idea identify if image imagine impact important improve in include including increase indeed indicate individual industry information inside instead institution interest interesting international interview into investment involve issue it item its itself job join just keep key kid kill kind kitchen know knowledge land language large last late later laugh law lawyer lay lead leader learn least leave left leg legal less let letter level lie life light like likely line list listen little live local long look lose loss lot love low machine magazine main maintain major make man manage management manager many market marriage material matter may maybe me mean measure media medical meet meeting member memory mention message method middle might military million mind minute miss mission model modern moment money month more morning most mother mouth move movement movie much music must my myself name nation national natural nature near nearly necessary need network never new news newspaper next nice night no none nor north not note nothing notice now number occur of off offer office officer official often oil ok old on once one only onto open operation opportunity option or order organization other others our out outside over own owner page pain painting paper parent part participant particular particularly partner party pass past patient pattern pay peace people per perform performance perhaps period person personal phone physical pick picture piece place plan plant play player point police policy political politics poor popular population position positive possible power practice prepare present president pressure pretty prevent price private probably problem process produce product professional professor program project property protect prove provide public pull purpose push put quality question quickly quite race radio raise range rate rather reach read ready real reality realize really reason receive recent recently recognize record red reduce reflect region relate relationship religious remain remember remove repeat report represent republican require research resource respond response responsibility rest result return reveal rich right rise risk road rock role room rule run safe same save say scene school science scientist score sea season seat second section security see seek seem sell send senior sense series serious serve service set seven several sex sexual shake share she shoot short shot should shoulder show side sign significant similar simple simply since sing single sister sit site situation six size skill skin small smile so social society soldier some somebody someone something sometimes son song soon sort sound source south southern space speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step still stock stop store story strategy street strong structure student study stuff style subject success successful such suddenly suffer suggest summer support sure system table take talk task tax teach teacher team technology television tell ten tend term test than thank that the their them themselves then theory there these they thing think third this those though thought thousand threat three through throughout throw thus time to today together tonight too top total tough toward town trade traditional training travel treat treatment tree trial trip trouble true truth try turn twice two type under understand unit until up upon us use usually value various very victim view violence visit voice vote wait walk wall want war watch water way we weapon wear week weight well west western what whatever when where whether which while white who whole whom whose why wide wife will win wind window wish with within without woman wonder word work worker world worry would write writer wrong yard yeah year yes yet you young your yourself`

const COMMON_B = `am are is was were been being does did done doing has had having shall
mine yours hers ours theirs ourselves whichever below beneath beside besides
except for till towards underneath via unless whenever whereas wherever
anymore anyway anywhere apart everywhere few forth otherwise please seldom somewhat days
weeks years months hours minutes seconds times things words works working worked
text thin wording worse worst larger smaller longer shorter soft warm slow
empty therefore necessarily`

export const COMMON: Set<string> = (() => {
  const s = new Set<string>()
  COMMON_A.split(/\s+/).filter(Boolean).forEach((w) => s.add(w))
  COMMON_B.split(/\s+/).filter(Boolean).forEach((w) => s.add(w))
  return s
})()

/* ---------- 缩写展开（反向生效：课文是 do not，你打 don't 也算对） ---------- */
export const CONTRACTIONS: Record<string, string> = {
  "don't": "do not", "doesn't": "does not", "didn't": "did not", "won't": "will not",
  "can't": "can not", "cannot": "can not", "isn't": "is not", "aren't": "are not",
  "wasn't": "was not", "weren't": "were not", "haven't": "have not", "hasn't": "has not",
  "hadn't": "had not", "couldn't": "could not", "shouldn't": "should not",
  "wouldn't": "would not", "mustn't": "must not", "let's": "let us",
  "it's": "it is", "that's": "that is", "what's": "what is", "there's": "there is",
  "here's": "here is", "he's": "he is", "she's": "she is", "who's": "who is",
  "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
  "you're": "you are", "you've": "you have", "you'll": "you will", "you'd": "you would",
  "we're": "we are", "we've": "we have", "we'll": "we will", "we'd": "we would",
  "they're": "they are", "they've": "they have", "they'll": "they will", "they'd": "they would",
}

export const norm = (s: unknown) =>
  String(s).toLowerCase().replace(/[^a-z0-9]/g, "")
// 词条末词带标点（now. / next?），填槽时要去掉
export const bare = (s: unknown) =>
  String(s).replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "")

export function expandWord(w: string): string[] {
  const key = String(w).toLowerCase().replace(/[^a-z']/g, "")
  const rep = CONTRACTIONS[key]
  if (!rep) return [w]
  const parts = rep.split(" ")
  if (/^[A-Z]/.test(w)) parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1)
  return parts
}

/* ---------- 编辑距离（短词，含相邻换位 = 1） ---------- */
export function lev(a: string, b: string): number {
  const n = a.length, m = b.length
  if (Math.abs(n - m) > 2) return 9
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[n][m]
}

export type Verdict = "ok" | "typo" | "unsure" | "error"

export function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const d: number[] = []
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i)
  return (
    d.length === 2 &&
    d[1] === d[0] + 1 &&
    a[d[0]] === b[d[1]] &&
    a[d[1]] === b[d[0]]
  )
}

/** 单词级判定：一个词槽的全部规则。targetNorm 已归一化；p 为 ASR 置信度。 */
export function wordVerdict(
  targetNorm: string,
  rawTyped: string,
  p?: number | null,
): Verdict {
  const t = norm(rawTyped)
  if (!t) return "error"
  if (targetNorm === t) return "ok"
  if (expandWord(rawTyped).map(norm).indexOf(targetNorm) >= 0) return "ok"
  const lowConf = p !== undefined && p !== null && p < CONF_FLOOR
  if (lev(targetNorm, t) > 1) return lowConf ? "unsure" : "error"
  if (isTransposition(targetNorm, t)) return "typo"
  if (COMMON.has(t)) return lowConf ? "unsure" : "error"
  return lowConf ? "unsure" : "typo"
}

/* ---------- 漏尾音：单列一类，不扣分但进报表 ---------- */
export function endingKind(target: string, typed: string): "" | "漏尾" | "多尾" {
  if (!typed || !target) return ""
  if (COMMON.has(typed)) return ""
  if (target.length > typed.length && target.indexOf(typed) === 0) return "漏尾"
  if (typed.length > target.length && typed.indexOf(target) === 0) return "多尾"
  return ""
}

/* ---------- 难度阶梯：空位比例（相对整句词数） ---------- */
export const TIERS = [
  { name: "热身", ratio: 0.3 },
  { name: "骨架", ratio: 0.4 },
  { name: "半骨架", ratio: 0.6 },
  { name: "盲打", ratio: 1.0 },
] as const
export type TierName = (typeof TIERS)[number]["name"]
export const tierRatio = (tier: number) => TIERS[tier].ratio

/* ---------- 近音干扰项：候选词必须听上去像，否则等于送答案 ---------- */
export const HOMO: string[][] = [
  ["no", "know", "now", "not"], ["to", "too", "two"], ["for", "four", "fore"],
  ["there", "their"], ["here", "hear"], ["right", "write"], ["by", "buy", "bye"],
  ["one", "won"], ["son", "sun"], ["see", "sea"], ["would", "wood"],
  ["word", "world", "work"], ["than", "then"], ["of", "off"], ["live", "leave"],
  ["sit", "seat"], ["ship", "sheep"], ["will", "well"], ["what", "want"],
  ["where", "wear"], ["our", "are", "hour"], ["do", "due"], ["thing", "think"],
  ["next", "text"], ["should", "sure"], ["was", "what"], ["us", "as"],
  ["big", "bag"], ["bad", "bed"], ["man", "men"], ["full", "fool"], ["fun", "fan"],
  ["cat", "cut"], ["hot", "hat"], ["now", "no"], ["in", "an"], ["and", "end"],
  ["get", "got"], ["may", "my"], ["me", "may"], ["but", "bat"], ["hat", "that"],
  ["day", "they"], ["say", "says"], ["put", "pot"], ["left", "lift"], ["walk", "work"],
  ["is", "his", "as"], ["are", "our"], ["was", "were"], ["were", "where", "wear"],
  ["be", "bee"], ["been", "bean"], ["the", "they"], ["a", "an"], ["of", "have"],
  ["have", "has", "had"], ["for", "from"], ["do", "does", "did"],
]

export const HOMO_MAP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  HOMO.forEach((group) =>
    group.forEach((w) => {
      const list = m.get(w) || []
      group.forEach((x) => {
        if (x !== w && list.indexOf(x) < 0) list.push(x)
      })
      m.set(w, list)
    }),
  )
  return m
})()

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

/** 空位挑选：错词本必空 → 实词优先 → 空数=词数×比例（最少1最多整句）。同一个词只空第一次出现。
 *  marks: word→"known"|"learning"|"ignore"；wrongSet: 归一化错词集合。 */
export function blankTargets(
  words: { w: string }[],
  ratio: number,
  opts?: { wrongSet?: Set<string>; marks?: Record<string, string> },
): number[] {
  const wb = opts?.wrongSet || new Set<string>()
  const marks = opts?.marks || {}
  const n = words.length
  if (!n) return []
  const want = Math.min(n, Math.max(1, Math.round(n * ratio)))
  const seen = new Set<string>()
  const ranked: { i: number; pri: number; len: number }[] = []
  for (let i = 0; i < n; i++) {
    const nz = norm(words[i].w)
    if (!nz || seen.has(nz)) continue
    seen.add(nz)
    const mk = marks[nz] || ""
    if (mk === "ignore") continue
    const known = mk === "known"
    const fromWB = !known && wb.has(nz)
    const content = !COMMON.has(nz)
    ranked.push({ i, pri: known ? 3 : fromWB ? 0 : content ? 1 : 2, len: nz.length })
  }
  ranked.sort((a, b) => a.pri - b.pri || b.len - a.len || a.i - b.i)
  return ranked
    .slice(0, want)
    .map((r) => r.i)
    .sort((a, b) => a - b)
}

export function distractorsFor(word: string, vocab?: string[]): string[] {
  const nz = norm(word)
  const tiers: string[][] = [[], [], []]
  const seen = new Set([nz])
  const add = (ti: number, w: string) => {
    if (w && !seen.has(w)) {
      seen.add(w)
      tiers[ti].push(w)
    }
  }
  ;(HOMO_MAP.get(nz) || []).forEach((w) => add(0, w))
  ;(vocab || []).forEach((v) => {
    if (lev(nz, v) <= 2) add(1, v)
  })
  if (tiers[0].length + tiers[1].length < 3) {
    for (const c of COMMON) {
      if (tiers[2].length >= 5) break
      if (c.length < 2) continue
      if (c[0] === nz[0] && Math.abs(c.length - nz.length) <= 1) add(2, c)
    }
  }
  tiers.forEach(shuffle)
  const out = tiers[0].concat(tiers[1], tiers[2])
  const list = [nz].concat(out.slice(0, 3))
  shuffle(list)
  return list
}
