import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "@/lib/trpc"

/**
 * 删课。`attempts.lesson_id` 和 `wrong_words.lesson_id` 都是 onDelete cascade，
 * 所以课程列表、练习记录、错词本三张表一起失效。
 */
export function useDeleteLesson() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const lessonsKey = trpc.lessons.list.queryKey()
  const attemptsKey = trpc.attempts.list.queryKey()
  const wbKey = trpc.wb.list.queryKey()
  const wbStatsKey = trpc.wb.stats.queryKey()

  return useMutation(
    trpc.lessons.remove.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: lessonsKey }),
          queryClient.invalidateQueries({ queryKey: attemptsKey }),
          queryClient.invalidateQueries({ queryKey: wbKey }),
          queryClient.invalidateQueries({ queryKey: wbStatsKey }),
        ])
      },
    }),
  )
}
