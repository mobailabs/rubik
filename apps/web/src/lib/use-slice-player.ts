import { useCallback, useEffect, useMemo, useRef } from "react"

export type Slice = { audioUrl: string; startMs: number; endMs: number }

/**
 * 播放一段音频里的某个切片（错词本按词播、练习页按词播都用它）。
 *
 * 三件事必须一起做，缺一个就会「点了播放却放出整句」—— 这是踩过的坑：
 *
 *  1. **赋值 src 之后 readyState=0，直接设 currentTime 会被丢掉**（白 seek，
 *     下次从 0s 开播）。所以没元数据时要等 `loadeddata` 再 seek。
 *  2. **到 endMs 必须刹车**。双保险：按切片时长算的精确 `setTimeout`
 *     ＋ `timeupdate` 兜底（后台标签页的定时器会被节流到秒级，光靠定时器会晚）。
 *  3. **慢速播放时刹车时长要按倍率放大**，否则词尾会被掐断。
 *
 * `cue()` 换片（预热 + seek 到起点，但**不自动播** —— 「别擅自放声」）；
 * `play()` 才真的出声。
 */
export function useSlicePlayer() {
  const ref = useRef<HTMLAudioElement | null>(null)
  const endRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearEnd = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    clearEnd()
    endRef.current = null
    ref.current?.pause()
  }, [clearEnd])

  useEffect(() => {
    const a = ref.current
    if (!a) return
    const onTime = () => {
      if (endRef.current != null && a.currentTime >= endRef.current) {
        a.pause()
        endRef.current = null
        clearEnd()
      }
    }
    a.addEventListener("timeupdate", onTime)
    return () => {
      a.removeEventListener("timeupdate", onTime)
      a.pause()
      clearEnd()
    }
  }, [clearEnd])

  const cue = useCallback(
    (s: Slice | null) => {
      const a = ref.current
      if (!a || !s) return
      a.pause()
      endRef.current = null
      clearEnd()
      a.src = s.audioUrl
      const seek = () => {
        a.currentTime = s.startMs / 1000
      }
      if (a.readyState >= 1) seek()
      else a.addEventListener("loadeddata", seek, { once: true })
    },
    [clearEnd],
  )

  const play = useCallback(
    (s: Slice, rate = 1) => {
      const a = ref.current
      if (!a) return
      const start = s.startMs / 1000
      const end = s.endMs / 1000
      const begin = () => {
        a.playbackRate = rate
        a.currentTime = start
        clearEnd()
        endRef.current = end
        timerRef.current = window.setTimeout(
          () => {
            a.pause()
            endRef.current = null
            clearEnd()
          },
          Math.max(120, ((end - start) * 1000) / rate + 60),
        )
        a.play().catch(() => {
          endRef.current = null
          clearEnd()
        })
      }
      if (a.readyState >= 1) begin()
      else a.addEventListener("loadeddata", begin, { once: true })
    },
    [clearEnd],
  )

  /* 返回稳定的对象：调用方会把它放进 useEffect 依赖（换词时 cue 一次），
     每次渲染都换新对象会让那个 effect 每帧重跑、把正在播的切片重置掉。 */
  return useMemo(() => ({ ref, cue, play, stop }), [cue, play, stop])
}
