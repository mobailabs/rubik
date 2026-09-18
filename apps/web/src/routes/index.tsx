import { createFileRoute, redirect } from "@tanstack/react-router"
import { HOME_PATH } from "@/lib/guards"

/**
 * 自用单用户，不需要落地页：直接进应用。
 * 未登录的情况交给 /dashboard 的守卫（它会 redirect 到 /sign-in）——
 * 这里不自己查一次会话，省一次跨洋 DB 往返。
 *
 * 原来的 `/` 是 Cloudflare 模板的营销页（"Ship fullstack on Cloudflare"），
 * 每次访问都多一屏无关内容，已连同 components/landing/ 一起删掉。
 *
 * 落点用 `HOME_PATH` 而不是写死 —— 首页是统计页（见 guards.ts 的注释），
 * 想要改回去只动那一个常量。
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: HOME_PATH })
  },
})
