import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { authClient, unwrap } from "@/lib/auth"
import { forgetGuardCache, HOME_PATH } from "@/lib/guards"

export type EmailSignIn = {
  email: string
  password: string
  rememberMe: boolean
}

export function useEmailSignIn() {
  const navigate = useNavigate()

  return useMutation({
    mutationFn: async (input: EmailSignIn) => {
      unwrap(
        await authClient.signIn.email({
          ...input,
          callbackURL: `${window.location.origin}${HOME_PATH}`,
        }),
        "Could not sign in.",
      )
    },
    onSuccess: () => {
      forgetGuardCache()
      return navigate({ to: HOME_PATH })
    },
  })
}
