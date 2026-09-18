import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "@/lib/trpc"

export function useSetRole() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const usersKey = trpc.admin.users.queryKey()
  const auditKey = trpc.admin.audit.queryKey()

  return useMutation(
    trpc.admin.setRole.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: usersKey })
        await queryClient.invalidateQueries({ queryKey: auditKey })
      },
    }),
  )
}
