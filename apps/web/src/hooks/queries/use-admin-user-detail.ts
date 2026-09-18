import { useQuery } from "@tanstack/react-query"
import { useTRPC, type RouterOutputs } from "@/lib/trpc"

export type AdminUserDetail = RouterOutputs["admin"]["userDetail"]

export function useAdminUserDetail(userId: string) {
  const trpc = useTRPC()
  return useQuery(trpc.admin.userDetail.queryOptions({ userId }))
}
