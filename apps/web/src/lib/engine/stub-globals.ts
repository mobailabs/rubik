/* 浏览器全局桩：让 PracticeEngine 在 Node 里能跑（不依赖真实 DOM/音频/存储）。
   必须在导入 usePractice 之前被求值——引擎模块顶层会读 window.matchMedia 算 IS_TOUCH。 */
const g = globalThis as any
g.window = {
  matchMedia: () => ({ matches: false }),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}
g.document = {
  activeElement: null,
  addEventListener: () => {},
  removeEventListener: () => {},
}
const _store: Record<string, string> = {}
g.localStorage = {
  getItem: (k: string) => (k in _store ? _store[k] : null),
  setItem: (k: string, v: string) => { _store[k] = String(v) },
  removeItem: (k: string) => { delete _store[k] },
}
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = () => {}
