import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "@/lib/trpc"

/**
 * 封禁 / 解封共用一个失效集合：列表、审计、以及打开着的详情面板。
 * 详情面板的 key 带 input，但按前缀失效照样命中。
 */
function useBanInvalidator() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const usersKey = trpc.admin.users.queryKey()
  const auditKey = trpc.admin.audit.queryKey()
  const detailKey = trpc.admin.userDetail.queryKey()

  return async () => {
    await queryClient.invalidateQueries({ queryKey: usersKey })
    await queryClient.invalidateQueries({ queryKey: auditKey })
    await queryClient.invalidateQueries({ queryKey: detailKey })
  }
}

export function useBanUser() {
  const trpc = useTRPC()
  const invalidate = useBanInvalidator()
  return useMutation(
    trpc.admin.banUser.mutationOptions({ onSuccess: invalidate }),
  )
}

export function useUnbanUser() {
  const trpc = useTRPC()
  const invalidate = useBanInvalidator()
  return useMutation(
    trpc.admin.unbanUser.mutationOptions({ onSuccess: invalidate }),
  )
}
