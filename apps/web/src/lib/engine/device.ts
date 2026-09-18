/**
 * 触屏判定 —— 引擎 / 练习页 / 错词页三处的唯一来源。
 *
 * 之前引擎和练习页各写了一份：引擎只看 `matchMedia`，练习页多一个 `?touch=`
 * 覆盖。于是桌面浏览器上 `?touch=1` 会让**界面**走触屏分支、**引擎**还走桌面
 * 分支（IS_TOUCH=false 时 loadSentence 会去 focus 一个不存在的 input），
 * 两条路径的判定必须同源。
 *
 * `?touch=1` / `?touch=0` 是给桌面浏览器验触屏布局用的（真机没法反着验桌面）。
 */
export function isTouchDevice(): boolean {
  // `window.location` 也要判：engine-smoke 的 DOM 桩有 window 但没有 location
  if (typeof window === "undefined" || !window.location) return false
  const m = /[?&]touch=([01])/.exec(window.location.search)
  if (m) return m[1] === "1"
  if (!window.matchMedia) return false
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches
}
