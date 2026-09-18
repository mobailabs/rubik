import { createFileRoute } from "@tanstack/react-router"
import { useAttempts } from "@/hooks/queries/use-attempts"
import { pageHead } from "@/lib/site"

export const Route = createFileRoute("/dashboard/progress/")({
  head: () =>
    pageHead({ title: "Progress", path: "/dashboard/progress", noIndex: true }),
  component: ProgressPage,
})

function ProgressPage() {
  const { data: attempts, isLoading, error } = useAttempts()

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    )
  if (!attempts?.length)
    return <p className="text-muted-foreground text-sm">No attempts yet.</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Progress</h1>
      <ul className="divide-y rounded-xl border">
        {attempts.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between px-3 py-2.5 text-sm"
          >
            <span className="font-medium">{a.lessonId}</span>
            <span className="text-muted-foreground">
              正确率 {a.accuracy ?? a.score}% · {a.durationSec ?? 0}s ·{" "}
              {new Date(a.createdAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
