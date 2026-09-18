import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { authClient } from "@/lib/auth"
import { forgetGuardCache } from "@/lib/guards"

export function useSignOut() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message ?? "Could not sign out.")
    },
    onSuccess: async () => {
      queryClient.clear()
      forgetGuardCache()
      await navigate({ to: "/sign-in" })
    },
  })
}
