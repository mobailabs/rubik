import { useEffect, useState } from "react"
import type { CSSProperties } from "react"

/**
 * 「现在真正看得见的那块区域」—— 手机上的软键盘不改变布局视口，
 * 只砍掉可视视口。`position: fixed; bottom: 0` 的元素算的是布局视口，
 * 所以键盘一弹就被整个盖住，正在打的那几行也一起落到键盘下面。
 *
 * 唯一可靠的来源是 `window.visualViewport`：
 *   height    可视视口高（键盘弹起时 = 键盘上沿以上的部分）
 *   offsetTop 可视视口相对布局视口的纵向偏移（iOS 为露出输入框会滚它）
 *
 * 触屏页据此把自己**钉在可视视口上**（`height: --vvh; transform: translateY(--vvo)`），
 * 内部再用 flex 列分空间：内容贴底（`margin-top: auto`）+ 末尾的答题条。
 * 容器跟着可视视口变矮，贴底的内容自然就落在可见区下沿 —— 不用算任何偏移。
 *
 * `?kb=340` 是给桌面浏览器验键盘布局用的（真机没法反着验），和 device.ts 的
 * `?touch=1` 同一套路：命中即整个绕过 visualViewport，键盘高度按参数算。
 */
export type VisualViewportMetrics = {
  height: number
  offsetTop: number
}

function debugKb(): number | null {
  if (typeof window === "undefined" || !window.location) return null
  const m = /[?&]kb=(\d+)/.exec(window.location.search)
  return m ? Number(m[1]) : null
}

function read(): VisualViewportMetrics {
  const inner = typeof window === "undefined" ? 0 : window.innerHeight
  const dbg = debugKb()
  if (dbg !== null) return { height: Math.max(0, inner - dbg), offsetTop: 0 }
  const vv = typeof window === "undefined" ? undefined : window.visualViewport
  if (!vv || !inner) return { height: inner, offsetTop: 0 }
  return {
    height: Math.round(vv.height),
    offsetTop: Math.max(0, Math.round(vv.offsetTop)),
  }
}

export function useVisualViewport(): VisualViewportMetrics {
  const [m, setM] = useState<VisualViewportMetrics>(read)

  useEffect(() => {
    if (debugKb() !== null) return
    const vv = window.visualViewport
    const update = () =>
      setM((prev) => {
        const next = read()
        return prev.height === next.height && prev.offsetTop === next.offsetTop
          ? prev
          : next
      })
    update()
    vv?.addEventListener("resize", update)
    vv?.addEventListener("scroll", update)
    // 没有 visualViewport 的浏览器至少还能跟着窗口尺寸走
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    return () => {
      vv?.removeEventListener("resize", update)
      vv?.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [])

  return m
}

/** 写进 `--vvh` / `--vvo` 给 CSS 用（自定义属性不在 CSSProperties 里，要强转）。 */
export function vvStyle(m: VisualViewportMetrics): CSSProperties {
  return {
    "--vvh": `${m.height}px`,
    "--vvo": `${m.offsetTop}px`,
  } as CSSProperties
}
