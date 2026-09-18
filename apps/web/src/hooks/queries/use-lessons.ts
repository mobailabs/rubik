import { useQuery } from "@tanstack/react-query"
import { useTRPC, type RouterOutputs } from "@/lib/trpc"

export type Lesson = RouterOutputs["lessons"]["list"][number]
export type LessonProgress = RouterOutputs["lessons"]["progress"][number]

export function useLessons() {
  const trpc = useTRPC()
  return useQuery(trpc.lessons.list.queryOptions())
}

export function useLesson(id: string) {
  const trpc = useTRPC()
  return useQuery(trpc.lessons.get.queryOptions({ id }))
}

/** 每门课练过几轮 / 上次多少分。课程卡的进度行用它。 */
export function useLessonProgress() {
  const trpc = useTRPC()
  return useQuery(trpc.lessons.progress.queryOptions())
}
