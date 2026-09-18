/**
 * 站点身份与对外 URL 的唯一来源（前端侧）。
 *
 * URL 的设计取舍：
 * - `site.url` 只用于 canonical link，canonical 的正确定义就是"用户当前访问用的域名"。
 *   所以直接取 `window.location.origin` —— 将来换成自定义域也不用改代码、不用加 env。
 * - 需要强制锁定某一个域时（多个域指向同一份部署、只认其一）才设 `VITE_SITE_URL`。
 * - ⚠️ 但 `apps/web/index.html` 里的 og:image / twitter:image **必须写死绝对 URL**
 *   （爬虫不跑 JS，拿不到运行时值）。换域名时那里要和这里一起改，
 *   同时改 `apps/api/wrangler.jsonc` 的 `APP_URL` / `BETTER_AUTH_URL`。
 */
const FIXED_URL = String(import.meta.env.VITE_SITE_URL ?? "").trim()

export const site = {
  name: "Rubik",
  url:
    FIXED_URL ||
    (typeof window === "undefined"
      ? "https://rubik.sajo66319.workers.dev"
      : window.location.origin),
  description:
    "英语听写打字练习：上传音频转写成课程，挖空听写、即时判定，错词按到期日复习。",
} as const

export function pageHead(opts: {
  title?: string
  description?: string
  path: string
  noIndex?: boolean
}) {
  return {
    meta: [
      { title: opts.title ? `${opts.title} · ${site.name}` : site.name },
      { name: "description", content: opts.description ?? site.description },
      ...(opts.noIndex ? [{ name: "robots", content: "noindex" }] : []),
    ],
    links: opts.noIndex
      ? []
      : [{ rel: "canonical", href: `${site.url}${opts.path}` }],
  }
}
