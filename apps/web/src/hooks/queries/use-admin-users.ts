import { useQuery } from "@tanstack/react-query"
import { useTRPC, type RouterOutputs } from "@/lib/trpc"

export type AdminUser = RouterOutputs["admin"]["users"]["items"][number]

export function useAdminUsers(q: string) {
  const trpc = useTRPC()
  return useQuery(
    trpc.admin.users.queryOptions({
      q: q.trim() || undefined,
      limit: 50,
      offset: 0,
    }),
  )
}
