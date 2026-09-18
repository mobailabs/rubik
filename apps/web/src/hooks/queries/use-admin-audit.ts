import { useQuery } from "@tanstack/react-query"
import { useTRPC, type RouterOutputs } from "@/lib/trpc"

export type AdminAuditEntry = RouterOutputs["admin"]["audit"]["items"][number]

export function useAdminAudit() {
  const trpc = useTRPC()
  return useQuery(trpc.admin.audit.queryOptions({ limit: 30 }))
}
