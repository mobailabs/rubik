/**
 * 是否本地 / 内网开发环境。
 *
 * 用于让 CORS 与 Better Auth 在 dev 下反射浏览器实际来源（localhost、10/172.16、
 * 192.168 私有网段、以及 CGNAT 100.64/10 这类 100.x 隧道地址），这样从别的设备
 * 经 LAN IP 打开 dev server 也能正常联调；线上（workers.dev / 自定义域名）仍严格
 * 只认 APP_URL，不削弱生产安全。
 */
export function isLocalEnv(env: { APP_URL?: string }): boolean {
  const url = env.APP_URL ?? ""
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(url)
}
