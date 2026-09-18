/**
 * 触屏端底部答题条 + 底部面板的样式。
 *
 * 练习页和错词本共用同一条答题条（输入框 + 校验 + 一排 44px 的 chip），
 * 所以样式放一处 —— 两边各写一份必然会漂移。
 *
 * 这里的 `position:fixed; bottom:0` 只是**默认值**：两个触屏页都把 .dock 放进
 * 自己那条「钉在可视视口上的 flex 列」的末尾（见各页 data-touch 分支），
 * 由那一侧改成 `position:static`。这样键盘弹起时答题条落在键盘上沿、
 * 内容区收缩到剩下的高度里，而不是各自跟 visualViewport 算偏移。
 */
export const DOCK_CSS = `
.dock{position:fixed;left:0;right:0;bottom:0;z-index:45;background:var(--popover);border-top:1px solid var(--border);padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 28px -20px rgba(0,0,0,.4)}
.dock-row{display:flex;gap:8px;align-items:center}
.dock-input{flex:1;min-width:0;font:17px/1.3 ui-monospace,SFMono-Regular,Menlo,system-ui,sans-serif;padding:9px 12px;height:44px;box-sizing:border-box;border:1px solid var(--input);border-radius:10px;background:var(--background);color:var(--foreground);outline:none}
.dock-input:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in oklab,var(--primary) 18%,transparent)}
.dock-input.off{opacity:.55}
.dock-input::placeholder{color:var(--muted-foreground);letter-spacing:.1em}
.dock-ok{flex:none;width:54px;height:44px;border-radius:10px;border:none;background:var(--primary);color:var(--primary-foreground);font-size:17px;font-weight:600;cursor:pointer;font-family:inherit}
.dock-ok:disabled{opacity:.4}
.dock-ok:not(:disabled):active{filter:brightness(1.15)}
/* 6 个 chip（播放/慢速/看答案/会了/下一个/更多）要能在 390px 上排成一行，
   否则最后一个会单独掉到第二行。padding 10px 是实测能塞下的值；
   flex-wrap 留着兜底，标签再长也只是换行，不会横向滚动（手机上没这个手势提示）。 */
.dock-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{flex:none;height:44px;padding:0 10px;border-radius:9px;border:1px solid var(--border);background:var(--background);color:var(--foreground);font-size:13px;font-family:inherit;cursor:pointer;white-space:nowrap}
.chip.primary{background:var(--primary);color:var(--primary-foreground);border-color:transparent;font-weight:600}
.chip.danger{color:var(--err)}
.chip:active{background:var(--muted)}
.dock-next{width:100%;height:50px;border-radius:11px;border:none;background:var(--primary);color:var(--primary-foreground);font-size:16px;font-weight:600;font-family:inherit;cursor:pointer}
.dock-toast{position:fixed;left:50%;transform:translateX(-50%);z-index:48;background:var(--popover);border:1px solid var(--border);border-radius:9px;padding:8px 16px;font-size:13px;box-shadow:0 10px 30px -14px rgba(0,0,0,.4)}
.sheet{position:fixed;inset:0;z-index:70;background:color-mix(in srgb,var(--background) 55%,transparent);display:flex;align-items:flex-end;justify-content:center}
.sheet-box{width:100%;max-width:560px;background:var(--card);border:1px solid var(--border);border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px))}
.sheet-t{font-size:12px;letter-spacing:.14em;color:var(--muted-foreground);font-weight:600;margin-bottom:12px}
.sheet-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.sheet-btn{height:48px;border:1px solid var(--border);border-radius:10px;background:var(--background);color:var(--foreground);font-size:14px;font-family:inherit;cursor:pointer}
.sheet-btn:active{background:var(--muted)}
.sheet-close{margin-top:12px;width:100%;height:44px;border:none;background:none;color:var(--muted-foreground);font-size:14px;font-family:inherit;cursor:pointer}
`
