import { createDB } from "@repo/db"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { sendPasswordResetEmail, sendVerificationEmail } from "../email"
import { bootstrapAdmin } from "./bootstrap"
import {
  allowSignUp,
  isPluginAdminPathAllowed,
  isSignUpPath,
} from "./policy"
import { isLocalEnv } from "../lib/dev"

export function createAuth(env: Env) {
  return betterAuth({
    database: drizzleAdapter(createDB(env.DATABASE_URL), { provider: "pg" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // dev 反射浏览器实际来源（含 LAN/CGNAT），方便远程设备联调；生产只认 APP_URL。
    trustedOrigins: (request) => {
      if (isLocalEnv(env)) {
        const origin = request?.headers.get("origin")
        return origin ? [origin, env.APP_URL] : [env.APP_URL]
      }
      return [env.APP_URL]
    },
    emailAndPassword: {
      enabled: true,
      // 不强制验证：注册默认关着（ALLOW_SIGNUP），而邮件目前发不出去
      // （见 email/index.ts）—— 强制验证只会把用 ALLOW_SIGNUP 临时开的账号锁在门外。
      // 等 EMAIL binding 真能发信了再打开这一项。
      requireEmailVerification: false,
      sendResetPassword: ({ user, url }) =>
        sendPasswordResetEmail(env, user.email, url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        sendVerificationEmail(env, user.email, url),
    },
    socialProviders: {
      ...(env.GITHUB_CLIENT_ID
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.GOOGLE_CLIENT_ID
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
    },
    plugins: [admin()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // 自用单用户：注册默认关死。
        //
        // 这不是洁癖 —— 站点在公网（rubik.sajo66319.workers.dev），开放注册等于
        // 任何人都能拿你的 S3 和 whisper 转写接口。前端把 /sign-up 重定向到 /sign-in
        // 只是体验，真正的边界在这里（直接 POST /api/auth/sign-up/email 也进不来）。
        //
        // 要临时开一个账号：wrangler.jsonc 里设 ALLOW_SIGNUP="true" 再 deploy。
        if (!allowSignUp(env) && isSignUpPath(ctx.path)) {
          throw new APIError("FORBIDDEN", { message: "注册已关闭" })
        }

        // 插件的 /admin/* 公开可打，而审计只在 tRPC 侧写；规则见 policy.isPluginAdminPathAllowed。
        if (isPluginAdminPathAllowed(ctx.path)) return

        throw new APIError("FORBIDDEN", {
          message: "管理操作请在应用内的管理页进行",
        })
      }),
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await bootstrapAdmin(env, session.userId)
          },
        },
      },
    },
  })
}
