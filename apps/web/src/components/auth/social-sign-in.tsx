import { useSocialSignIn } from "@/hooks/mutations/use-social-sign-in"
import type { SocialProvider } from "@/lib/auth"
import { FormError } from "./form-error"
import { SocialSignInButton } from "./social-sign-in-button"

const PROVIDERS: readonly SocialProvider[] = ["github", "google"]

/**
 * 构建期白名单：`VITE_OAUTH=github,google`。
 *
 * 服务端（`apps/api/src/auth/index.ts`）也是按 env 有没有 ID 来决定挂不挂 provider，
 * 两边必须一致 —— 否则按钮渲染出来了、点下去服务端没配，只会报错。
 * 目前 dev 和 prod 的 OAuth 四项都是空的，所以两个环境都不出按钮。
 * 真要开：填 `.dev.vars` / `.prod.vars` 的 GITHUB_*、GOOGLE_*，并在构建时带上这个变量。
 */
const ENABLED = String(import.meta.env.VITE_OAUTH ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as SocialProvider[]

/** 有没有启用第三方登录。外层用它决定要不要渲染分隔线（否则会留一条孤零零的 "or"）。 */
export const oauthEnabled = ENABLED.length > 0

export function SocialSignIn() {
  const signIn = useSocialSignIn()
  const providers = PROVIDERS.filter((p) => ENABLED.includes(p))

  // 一个都没配就整块不渲染，连分隔线和间距都不留（避免出现空的按钮行）
  if (!oauthEnabled) return null

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        {providers.map((provider) => (
          <SocialSignInButton
            key={provider}
            provider={provider}
            pending={signIn.isPending && signIn.variables === provider}
            disabled={signIn.isPending}
            onSignIn={() => signIn.mutate(provider)}
          />
        ))}
      </div>
      <FormError message={signIn.error?.message} />
    </div>
  )
}
