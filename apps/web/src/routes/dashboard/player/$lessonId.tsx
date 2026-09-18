import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { readProgress, writeProgress } from "@/lib/player-progress"

export const Route = createFileRoute("/dashboard/player/$lessonId")({
  head: () => ({ meta: [{ title: "Player" }] }),
  component: JumpToPlayer,
})

/** 旧的单课链接：记下要播哪一课，回到整库播放页接着播。 */
function JumpToPlayer() {
  const { lessonId } = Route.useParams()
  const navigate = useNavigate()

  useEffect(() => {
    const prev = readProgress()
    writeProgress({
      lessonId,
      time: prev?.lessonId === lessonId ? prev.time : 0,
      rate: prev?.rate ?? 1,
    })
    void navigate({ to: "/dashboard/player", replace: true })
  }, [lessonId, navigate])

  return <p className="text-muted-foreground text-sm">正在打开…</p>
}
