import { useTRPC } from "@/lib/trpc"
import { useQuery, useMutation } from "@tanstack/react-query"

export function useAttempts() {
  const trpc = useTRPC()
  return useQuery(trpc.attempts.list.queryOptions())
}

/**
 * 统计页的全部数据（服务端聚合好的，见 attempts.stats 的注释）。
 *
 * 和 `useAttempts` 分开：那个是进 Progress 页就拉的原始记录，量大且没用；
 * 这个只在统计页用，返回的是几十个汇总数字。
 */
export function useAttemptStats() {
  const trpc = useTRPC()
  return useQuery(trpc.attempts.stats.queryOptions())
}

export function useSaveAttempt() {
  const trpc = useTRPC()
  return useMutation(trpc.attempts.save.mutationOptions())
}
