import { useMemo, useRef, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useDeleteLesson } from "@/hooks/mutations/use-delete-lesson"
import { useLessonProgress, useLessons } from "@/hooks/queries/use-lessons"
import { useTRPC } from "@/lib/trpc"
import { env } from "@/lib/env"
import { localCheckpoint, DOSE_MIN, mmss, relTime, todaySec } from "@/lib/lesson-queue"
import { pageHead } from "@/lib/site"
import { Button } from "@repo/ui/components/button"
import { cn } from "@repo/ui/lib/utils"

export const Route = createFileRoute("/dashboard/practice/")({
  head: () =>
    pageHead({ title: "Practice", path: "/dashboard/practice", noIndex: true }),
  component: PracticeListPage,
})

type UploadState =
  | { kind: "idle" }
  | {
      kind: "working"
      current: number
      total: number
      name: string
      imported: number
      failed: number
      skipped: number
    }
  | {
      kind: "done"
      total: number
      imported: number
      failed: number
      skipped: number
      lastTitle: string
      lastSentences: number
      lastError: string
      failedNames: string[]
      skippedNames: string[]
    }

const ACCEPT = "audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.webm"

function tally(state: {
  imported: number
  failed: number
  skipped: number
}): string {
  const bits: string[] = []
  if (state.imported) bits.push(`已完成 ${state.imported}`)
  if (state.failed) bits.push(`失败 ${state.failed}`)
  if (state.skipped) bits.push(`跳过 ${state.skipped}`)
  return bits.length ? ` · ${bits.join(" · ")}` : ""
}

function progressText(state: UploadState): string {
  if (state.kind === "idle") return ""
  if (state.kind === "working") {
    return `转写中 ${state.current}/${state.total}：${state.name}…${tally(state)}`
  }
  if (state.imported === 0 && state.failed === 0 && state.skipped > 0) {
    if (state.skipped === 1) {
      return `已跳过：${state.skippedNames[0]}（文件名已存在）`
    }
    return `已跳过 ${state.skipped} 个（文件名已存在）`
  }
  if (state.total === 1 && state.imported === 1 && !state.skipped) {
    return `已导入：${state.lastTitle} · ${state.lastSentences} sentences`
  }
  if (state.total === 1 && state.failed === 1 && !state.skipped) {
    return `导入失败：${state.lastError}`
  }
  const bits: string[] = []
  if (state.imported) bits.push(`已导入 ${state.imported} 个`)
  if (state.skipped) bits.push(`跳过 ${state.skipped} 个`)
  if (state.failed) {
    const names = state.failedNames.slice(0, 2).join("、")
    const extra = state.failedNames.length > 2 ? "…" : ""
    bits.push(`失败 ${state.failed} 个${names ? `（${names}${extra}）` : ""}`)
  }
  return bits.join(" · ")
}

function PracticeListPage() {
  const { data: lessons, isLoading, error } = useLessons()
  const trpc = useTRPC()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<UploadState>({ kind: "idle" })
  const remove = useDeleteLesson()
  // 一次性拉所有 wb 行（含 mastered），按 lessonId 计数 —— 删课时显示
  // 「将清除 N 条错词记录」让用户改主意。仅 active scope 不够（可能这门课全
  // 已会、误删仍有 N 条数据丢失的提示）。
  const wbAll = useQuery(trpc.wb.list.queryOptions({ scope: "all" }))
  const wbByLesson = useMemo(() => {
    const m = new Map<string, number>()
    ;(wbAll.data ?? []).forEach((r) => {
      m.set(r.lessonId, (m.get(r.lessonId) ?? 0) + 1)
    })
    return m
  }, [wbAll.data])

  const progressQ = useLessonProgress()
  const progressByLesson = useMemo(
    () => new Map((progressQ.data ?? []).map((p) => [p.lessonId, p])),
    [progressQ.data],
  )
  /** 今天的累计练习时长 —— 和续课判定用的是同一个数，两处口径必须一致。 */
  const today = todaySec(progressQ.data)

  const lessonsQueryKey = trpc.lessons.list.queryKey()

  // 上传接口一次只收一个文件，而且转写就在这个请求里跑完，
  // 所以多选时排队、一个一个发，每发完一条就刷新列表。
  async function uploadOne(file: File) {
    const res = await fetch(`${env.apiUrl}/api/upload`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      skipped?: boolean
      title?: string
      sentenceCount?: number
      error?: string
    }
    if (data.skipped || res.status === 409) return { skipped: true as const }
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }

  async function uploadMany(files: File[]) {
    if (!files.length || state.kind === "working") return

    const taken = new Set(
      (lessons ?? []).flatMap((l) => (l.source ? [l.source] : [])),
    )
    const queued: File[] = []
    const skippedNames: string[] = []
    for (const file of files) {
      if (taken.has(file.name)) {
        skippedNames.push(file.name)
        continue
      }
      taken.add(file.name)
      queued.push(file)
    }

    let imported = 0
    let failed = 0
    let skipped = skippedNames.length
    let lastTitle = ""
    let lastSentences = 0
    let lastError = ""
    const failedNames: string[] = []

    const finish = () =>
      setState({
        kind: "done",
        total: queued.length,
        imported,
        failed,
        skipped,
        lastTitle,
        lastSentences,
        lastError,
        failedNames,
        skippedNames,
      })

    if (!queued.length) {
      finish()
      return
    }

    for (const [i, file] of queued.entries()) {
      setState({
        kind: "working",
        current: i + 1,
        total: queued.length,
        name: file.name,
        imported,
        failed,
        skipped,
      })
      try {
        const data = await uploadOne(file)
        if ("skipped" in data && data.skipped) {
          skipped++
          skippedNames.push(file.name)
        } else {
          imported++
          lastTitle = data.title ?? file.name
          lastSentences = data.sentenceCount ?? 0
        }
      } catch (e) {
        failed++
        lastError = (e as Error).message
        failedNames.push(file.name)
      }
      // 成功或失败都会落一条课（ready / failed），刷新让卡片马上出现
      await qc.invalidateQueries({ queryKey: lessonsQueryKey })
    }

    finish()
  }

  if (isLoading)
    return <p className="text-muted-foreground text-sm">Loading lessons…</p>
  if (error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    )

  const working = state.kind === "working"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Practice</h1>
          {/* 今日剂量。和续课判定同一个数 —— 在列表看到 18 分钟满了，
              练完下一门就不会被自动拽走，两处对得上。 */}
          {today > 0 && (
            <p
              className={cn(
                "text-xs",
                today >= DOSE_MIN * 60 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
              )}
            >
              今天已练 {mmss(today)}
              {today >= DOSE_MIN * 60
                ? ` · 够了（每日 ${DOSE_MIN} 分钟）`
                : ` / ${DOSE_MIN} 分钟`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={working}
            onClick={() => fileRef.current?.click()}
          >
            {working
              ? `转写中 ${state.current}/${state.total}`
              : "＋ 上传音频"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ""
              if (files.length) void uploadMany(files)
            }}
          />
        </div>
      </div>

      {state.kind !== "idle" && (
        <p
          aria-live="polite"
          role={state.kind === "done" && state.failed > 0 ? "alert" : undefined}
          className={cn(
            "text-sm",
            state.kind === "done" && state.failed > 0 && !state.imported
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {progressText(state)}
        </p>
      )}

      {remove.error && (
        <p role="alert" className="text-destructive text-sm">
          {remove.error.message}
        </p>
      )}

      {!lessons?.length ? (
        <p className="text-muted-foreground text-sm">
          No lessons yet. 点右上角「＋ 上传音频」导入音频。
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {lessons.map((lesson) => {
            const busy = lesson.status === "pending"
            const failed = lesson.status === "failed"
            return (
              <li key={lesson.id} className="relative">
                <Link
                  to="/dashboard/practice/$lessonId"
                  params={{ lessonId: lesson.id }}
                  aria-disabled={busy || failed}
                  className={cn(
                    "block rounded-xl border p-4 pr-12 transition-colors",
                    busy || failed
                      ? "pointer-events-none opacity-60"
                      : "hover:bg-muted/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{lesson.title}</p>
                    {busy && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        处理中…
                      </span>
                    )}
                    {failed && (
                      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
                        转写失败
                      </span>
                    )}
                  </div>
                  {busy ? (
                    <p className="text-muted-foreground text-xs">正在转写…</p>
                  ) : failed ? (
                    <p className="text-destructive text-xs">
                      {lesson.error || "转写失败"}
                    </p>
                  ) : (
                    <LessonCardMeta
                      lessonId={lesson.id}
                      sentenceCount={lesson.sentenceCount}
                      wordCount={lesson.wordCount}
                      progress={progressByLesson.get(lesson.id)}
                    />
                  )}
                </Link>
                <DeleteLessonButton
                  title={lesson.title}
                  wbCount={wbByLesson.get(lesson.id) ?? 0}
                  pending={
                    remove.isPending && remove.variables?.id === lesson.id
                  }
                  disabled={remove.isPending}
                  onDelete={() => remove.mutate({ id: lesson.id })}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * 课程卡的副行：练到哪了。
 *
 * 两个事实来源要分清，别混成一句：
 *   - 「已练 3 轮 · 上次 87% · 2 小时前」来自服务端（attempts 表），换设备也在；
 *   - 「第 14/32 句」来自本机 localStorage 的断点，只在这台机器上成立。
 *
 * 所以断点单独一行、带「本机」二字。不是多余的谨慎：两行混在一起写「已完成 44%」，
 * 用户换台电脑打开会以为进度丢了。
 */
function LessonCardMeta({
  lessonId,
  sentenceCount,
  wordCount,
  progress,
}: {
  lessonId: string
  sentenceCount: number
  wordCount: number
  progress: { rounds: number; lastAccuracy: number | null; lastAt: Date | string | null } | undefined
}) {
  // 断点在 localStorage 里，不是响应式的，但课程卡只在挂载/切换列表时出现，
  // 读一次就够（练习页返回时整页会重挂载）。
  const cp = localCheckpoint(lessonId, sentenceCount)
  const rounds = progress?.rounds ?? 0

  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs">
        {rounds > 0 ? (
          <>
            已练 {rounds} 轮
            {progress?.lastAccuracy != null && ` · 上次 ${Math.round(progress.lastAccuracy)}%`}
            {progress?.lastAt ? ` · ${relTime(progress.lastAt)}` : ""}
          </>
        ) : (
          "还没练过"
        )}
        {" · "}
        {sentenceCount} sentences · {wordCount} words
      </p>
      {cp && (
        <p className="text-muted-foreground/80 text-[11px]">
          第 {cp.sentence}/{sentenceCount} 句（本机断点）
        </p>
      )}
    </div>
  )
}

/**
 * 卡片右上角的删除入口。删课不可逆，所以走两步确认（点「删除」→ 换成
 * 「确认删除 / 取消」），不用 `window.confirm`：原生弹窗跟主题脱节，而且
 * 两步确认对键盘更顺 —— 两个按钮是换掉的，浏览器会把焦点丢到 body，
 * 所以这里用 rAF 把焦点搬过去（臂上 → 确认删除，取消 → 回到删除）。
 */
function DeleteLessonButton({
  title,
  wbCount,
  pending,
  disabled,
  onDelete,
}: {
  title: string
  /** 该课关联的错词数。>0 时第二步确认带上「将清除 N 条」，让用户改主意。 */
  wbCount: number
  pending: boolean
  disabled: boolean
  onDelete: () => void
}) {
  const [armed, setArmed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const arm = () => {
    setArmed(true)
    requestAnimationFrame(() => confirmRef.current?.focus())
  }
  const cancel = () => {
    setArmed(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  if (!armed)
    return (
      <Button
        ref={triggerRef}
        size="xs"
        variant="ghost"
        disabled={disabled}
        aria-label={`删除课程 ${title}`}
        className="text-muted-foreground hover:text-destructive absolute top-2.5 right-2.5"
        onClick={arm}
      >
        删除
      </Button>
    )

  return (
    <div className="absolute top-2.5 right-2.5 flex flex-col items-end gap-1">
      {wbCount > 0 && (
        <span className="text-muted-foreground text-[10px] leading-none">
          将清除 {wbCount} 条错词记录
        </span>
      )}
      <div className="flex items-center gap-1">
        <Button
          ref={confirmRef}
          size="xs"
          variant="destructive"
          disabled={pending}
          onClick={onDelete}
        >
          {pending ? "删除中…" : "确认删除"}
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={cancel}>
          取消
        </Button>
      </div>
    </div>
  )
}
