import { AuthHeading } from "./auth-heading"
import { Divider } from "./divider"
import { EmailSignInForm } from "./email-sign-in-form"
import { SocialSignIn, oauthEnabled } from "./social-sign-in"

// 没有「注册」入口：自用单用户，注册在服务端已关死（/sign-up 会重定向到这里）。
export function SignInPanel() {
  return (
    <div className="flex flex-col gap-6">
      <AuthHeading title="Sign in" />
      <EmailSignInForm />
      {oauthEnabled && <Divider label="or" />}
      <SocialSignIn />
    </div>
  )
}
