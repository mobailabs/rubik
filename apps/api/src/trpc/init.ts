import { initTRPC, TRPCError } from "@trpc/server"
import type { createDB } from "@repo/db"
import type { User } from "better-auth"
import type { S3Env } from "../lib/s3"

/**
 * 注意：这里刻意不引 `../auth`（或任何用到 Cloudflare `Env` 的模块）。
 * web 的 tsc 会顺着 `@repo/api/trpc` 连带检查这些源码，而 `Env` 是 wrangler 生成的
 * 全局声明，前端工程里没有。admin 路由要用的角色判定放在纯函数 policy 里。
 */
export type AuthUser = User & { role?: string | null }

export type Context = {
  db: ReturnType<typeof createDB>
  user: AuthUser | null
  s3: S3Env
}
const t = initTRPC.context<Context>().create()
export const router = t.router
export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" })
  return next({ ctx: { ...ctx, user: ctx.user } })
})

/** 真正的权限边界：非 admin 一律 403，前端隐藏入口只算体验。 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin")
    throw new TRPCError({ code: "FORBIDDEN", message: "需要管理员权限" })
  return next()
})
