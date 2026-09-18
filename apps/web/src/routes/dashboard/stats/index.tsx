import { createFileRoute, Link } from "@tanstack/react-router"
import { useAttemptStats } from "@/hooks/queries/use-attempts"
import { useLessonProgress, useLessons } from "@/hooks/queries/use-lessons"
import { mmss, relTime } from "@/lib/lesson-queue"
import { pageHead } from "@/lib/site"

export const Route = createFileRoute("/dashboard/stats/")({
  head: () => pageHead({ title: "Stats", path: "/dashboard/stats", noIndex: true }),
  component: StatsPage,
})

/**
 * 错误类型的固定顺序与颜色槽位。
 *
 * 顺序写死、颜色跟着类型走（不跟着当前排名走）：同一个「听错」在两次访问里
 * 必须是同一个颜色，否则看的人要重新学一遍配色。
 *
 * 颜色取自 palette 校验过的分类槽位（`scripts/validate_palette.js`，浅色与深色
 * 两套各自验证过 CVD 分离度与对比度）。**别手改这几个值**：它们是成套校验过的，
 * 单独换一个会让相邻两色的色盲分离度掉到阈值以下。要改就整组重跑校验。
 *
 * 槽位数 = 引擎的 TERMS 数（见 engine/usePractice.ts）。新增判定类型时这里要跟着加，
 * 但超过 8 个就该改成表格而不是继续加颜色。
 */
const KINDS = [
  { key: "听错", varName: "--viz-1" },
  { key: "留空", varName: "--viz-2" },
  { key: "漏尾", varName: "--viz-3" },
  { key: "多尾", varName: "--viz-4" },
  { key: "手滑", varName: "--viz-5" },
  { key: "存疑", varName: "--viz-6" },
] as const

/** 每种判定错在哪 —— 统计页要能回答"我该怎么办"，不只是"我错了几次"。 */
const KIND_TIPS: Record<string, string> = {
  听错: "词听成了另一个词，真正的听力缺口",
  留空: "没听出来就空着（比编一个词好）",
  漏尾: "词尾 -s / -ed / -t 漏了，ESL 头号问题",
  多尾: "多打了词尾，多半是上个词的收尾连了过来",
  手滑: "键盘动作失误，不计分",
  存疑: "转写本身没拿准，不计分",
}

/**
 * 课程标题其实是上传时的文件名（如 `doubao_tts_1788975800106`）。这类 TTS 产物
 * 的名字里唯一能区分彼此的**就是那串时间戳**，所以不能整个删掉 ——
 * 删光了 15 行全显示成 "tts"，比不处理还难认。
 *
 * 折中：去掉重复的前缀和大数位，留末尾 6 位当短标识（`…0106`）。
 * 别的命名（用户自己传的 `lesson_01.wav`）原样保留，不做假设。
 */
function shortTitle(t: string): string {
  const m = t.match(/^(.*?)[_-]?(\d{10,})$/)
  if (m) {
    const stem = m[1]!.replace(/^(doubao|tts)_/gi, "").replace(/[_-]+$/, "")
    const tail = m[2]!.slice(-4)
    return stem ? `${stem}…${tail}` : `…${tail}`
  }
  return t
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-muted-foreground text-xs">{label}</p>
      {/* 大数字用比例数字（不是 tabular-nums）——等宽会让 "121" 在大字号下散开 */}
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
    </div>
  )
}

function StatsPage() {
  const statsQ = useAttemptStats()
  const lessonsQ = useLessons()
  const progressQ = useLessonProgress()

  const titleById = new Map((lessonsQ.data ?? []).map((l) => [l.id, l.title]))

  if (statsQ.isLoading)
    return <p className="text-muted-foreground text-sm">加载中…</p>
  if (statsQ.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {statsQ.error.message}
      </p>
    )

  const s = statsQ.data
  if (!s || s.totals.rounds === 0)
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">统计</h1>
        <p className="text-muted-foreground text-sm">
          还没有练习记录。练完一轮就会出现在这里（
          <Link to="/dashboard/practice" className="underline">
            去练习
          </Link>
          ）。
        </p>
      </div>
    )

  const { totals, errors, hardest, wrongBook } = s
  // 错误分布的总数：用它算占比。全是 0 时下方会走"没有可统计的判定"分支。
  const errorTotal = errors.reduce((n, e) => n + e.n, 0)
  const errorByKind = new Map(errors.map((e) => [e.kind, e.n]))
  // 只有真的出现过（>0）的才画条：画一排 0 长度的条没有信息量，只会撑高度。
  const shownKinds = KINDS.filter((k) => (errorByKind.get(k.key) ?? 0) > 0)
  const maxError = Math.max(1, ...shownKinds.map((k) => errorByKind.get(k.key) ?? 0))

  // 句子难度榜：耗时最长的排前面。全部按平均每句耗时归一化。
  const maxSentSec = Math.max(1, ...hardest.map((h) => h.avgSec))

  const masteredPct = wrongBook.total
    ? Math.round((wrongBook.mastered / wrongBook.total) * 100)
    : 0

  return (
    <div className="flex flex-col gap-8">
      <style>{VIZ_TOKENS}</style>

      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">统计</h1>
        <p className="text-muted-foreground text-xs">
          {totals.firstAt ? relTime(totals.firstAt) + "开始" : ""}
          {totals.lastAt ? ` · 最近 ${relTime(totals.lastAt)}` : ""}
        </p>
      </div>

      {/* ---------- 总体盘子：几个头部数字用 stat tile，不画图 ---------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">总体</h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatTile
            label="累计练习"
            value={mmss(totals.totalSec)}
            sub={`${totals.rounds} 轮 · ${totals.lessonCount} 门课`}
          />
          <StatTile
            label="平均正确率"
            value={totals.avgAccuracy == null ? "—" : `${totals.avgAccuracy}%`}
            sub="每轮空位正确率的平均"
          />
          <StatTile
            label="平均每句耗时"
            value={`${totals.avgSecPerSentence.toFixed(1)}s`}
            sub={`${totals.totalSentences} 句`}
          />
          <StatTile
            label="累计重听"
            value={`${totals.totalListens} 次`}
            sub={
              totals.totalSentences
                ? `平均每句 ${(totals.totalListens / totals.totalSentences).toFixed(1)} 次`
                : undefined
            }
          />
        </div>
      </section>

      {/* ---------- 错误类型分布 ---------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">错误类型</h2>
          <p className="text-muted-foreground text-xs">
            共 {errorTotal} 处 · 只统计计分的类型
          </p>
        </div>

        {shownKinds.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有出现计分的错误判定（手滑、存疑这类不计分的不算）。
          </p>
        ) : (
          <div className="rounded-xl border bg-card p-4">
            {/* 单色条 + 直接标注数值。文本一律用 text token，不染数据色 ——
                浅色的黄/青直接当文字读不清。 */}
            <div className="flex flex-col gap-2.5">
              {shownKinds.map((k) => {
                const n = errorByKind.get(k.key) ?? 0
                const pct = errorTotal ? Math.round((n / errorTotal) * 100) : 0
                return (
                  <div key={k.key} className="flex items-center gap-3">
                    <span className="w-10 shrink-0 text-xs text-foreground">
                      {k.key}
                    </span>
                    {/* 轨道 + 填充。条高不超过 10px，圆角只给数据端 */}
                    <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-muted">
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-[4px]"
                        style={{
                          width: `${Math.max(2, (n / maxError) * 100)}%`,
                          background: `var(${k.varName})`,
                        }}
                      />
                    </span>
                    <span className="text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums">
                      {n} 次 · {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
            {/* 说明：错误类型是"该练什么"的线索，光给数字没用 */}
            <div className="mt-4 flex flex-col gap-1 border-t pt-3">
              {shownKinds.map((k) => (
                <p key={k.key} className="text-muted-foreground text-xs">
                  <span className="text-foreground">{k.key}</span> —{" "}
                  {KIND_TIPS[k.key]}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---------- 句子难度榜 ---------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">最磨人的句子</h2>
          <p className="text-muted-foreground text-xs">
            按平均耗时排 · 只列前 {hardest.length} 句
          </p>
        </div>
        {hardest.length === 0 ? (
          <p className="text-muted-foreground text-sm">还没有逐句记录。</p>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y">
              {hardest.map((h) => {
                // 只练过一两轮的句子，"平均"没有说服力 —— 标出来，别让人过度解读
                const thin = h.rounds < 2
                return (
                  <li
                    key={`${h.lessonId}#${h.n}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <span className="text-muted-foreground w-10 shrink-0 text-xs tabular-nums">
                      #{h.n}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Link
                          to="/dashboard/practice/$lessonId"
                          params={{ lessonId: h.lessonId }}
                          className="truncate text-xs hover:underline"
                        >
                          {shortTitle(titleById.get(h.lessonId) ?? h.lessonId)}
                        </Link>
                        {thin && (
                          <span className="text-muted-foreground shrink-0 text-[10px]">
                            仅 {h.rounds} 轮
                          </span>
                        )}
                        {h.wrongRounds > 0 && (
                          <span className="text-destructive shrink-0 text-[10px]">
                            错过 {h.wrongRounds} 次
                          </span>
                        )}
                      </div>
                      {/* 一根细条表示相对耗时 —— 同一色相、按量取长，不做彩虹渐变 */}
                      <span className="relative h-1.5 overflow-hidden rounded-sm bg-muted">
                        <span
                          className="absolute inset-y-0 left-0 rounded-r-[3px]"
                          style={{
                            width: `${Math.max(2, (h.avgSec / maxSentSec) * 100)}%`,
                            background: "var(--viz-1)",
                          }}
                        />
                      </span>
                    </div>
                    <span className="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">
                      {h.avgSec.toFixed(1)}s · 听 {h.avgListens.toFixed(1)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>

      {/* ---------- 错词本 ---------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">错词本</h2>
        {wrongBook.total === 0 ? (
          <p className="text-muted-foreground text-sm">错词本是空的。</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="待复习"
                value={`${wrongBook.due}`}
                sub={`共 ${wrongBook.total} 条，累计错过 ${wrongBook.hits} 次`}
              />
              <StatTile
                label="已会"
                value={`${wrongBook.mastered}`}
                sub={wrongBook.total ? `占 ${masteredPct}%` : undefined}
              />
              <StatTile
                label="涉及课程"
                value={`${wrongBook.byLesson.length}`}
                sub={
                  wrongBook.byLesson[0]
                    ? `最多的一门 ${wrongBook.byLesson[0].n} 条`
                    : undefined
                }
              />
            </div>

            {wrongBook.byLesson.length > 0 && (
              <div className="rounded-xl border bg-card p-4">
                <p className="text-muted-foreground mb-3 text-xs">
                  错词分布（哪些课的错词最多，优先复习这些）
                </p>
                <div className="flex flex-col gap-2">
                  {wrongBook.byLesson.slice(0, 8).map((l) => (
                    <Link
                      key={l.lessonId}
                      to="/dashboard/practice/$lessonId"
                      params={{ lessonId: l.lessonId }}
                      className="hover:bg-muted/50 -mx-1 flex items-center gap-3 rounded-md px-1 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {shortTitle(titleById.get(l.lessonId) ?? l.lessonId)}
                      </span>
                      <span className="bg-muted h-1.5 w-24 shrink-0 overflow-hidden rounded-sm">
                        <span
                          className="block h-full rounded-r-[3px]"
                          style={{
                            width: `${Math.max(4, (l.n / wrongBook.byLesson[0]!.n) * 100)}%`,
                            background: "var(--viz-1)",
                          }}
                        />
                      </span>
                      <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
                        {l.n}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-xl border bg-card p-4">
              <p className="text-muted-foreground mb-3 text-xs">
                最常错的词（跨课合并，同一个词在多门课出错算在一起）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {wrongBook.top.map((w) => (
                  <span
                    key={`${w.word}-${w.display}`}
                    className="bg-muted inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                  >
                    <span className="text-foreground">{w.display}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {w.hits}
                    </span>
                  </span>
                ))}
              </div>
              <p className="text-muted-foreground mt-3 text-xs">
                去{" "}
                <Link to="/dashboard/wb" className="underline">
                  错词本
                </Link>{" "}
                练今天到期的。
              </p>
            </div>
          </>
        )}
      </section>

      {/* 今日剂量：和续课判定同一个数，这里再给一次，方便一眼确认 */}
      <section className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>
          今日已练{" "}
          {mmss(
            (progressQ.data ?? []).reduce((n, p) => n + (p.todaySec ?? 0), 0),
          )}
        </p>
      </section>
    </div>
  )
}

/**
 * 可视化用的颜色槽位。
 *
 * 这几个值由 `validate_palette.js` 成套校验过（浅色 / 深色两套各自的色盲分离度、
 * 对比度、色度下限）。**不要单独改其中一个** —— 相邻槽位的 CVD 分离度是成套满足
 * 的，换掉一个会让某一对掉到阈值下。要动就整组重新校验。
 *
 * 浅色下 #1baf7a / #eda100 / #e87ba4 对背景的对比度低于 3:1，属于"需要补偿"档：
 * 所以每根条都直接标了数值，不靠颜色单独承载信息。
 */
const VIZ_TOKENS = `
:root{
  --viz-1:#3b5bdb;--viz-2:#eb6834;--viz-3:#1baf7a;
  --viz-4:#eda100;--viz-5:#e87ba4;--viz-6:#008300;
}
.dark{
  --viz-1:#3987e5;--viz-2:#d95926;--viz-3:#199e70;
  --viz-4:#c98500;--viz-5:#d55181;--viz-6:#008300;
}
`
