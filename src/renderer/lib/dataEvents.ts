/**
 * 数据变更通知（DEVPLAN 阶段 4）
 *
 * 用途：某个页面写入了别的模块的数据（例如备忘转成计划任务、首页勾选任务），
 * 需要让正在显示的其它页面重新加载，否则会出现"这边改了、那边还是旧的"。
 *
 * 实现用浏览器原生事件，不引入状态库；组件各自决定要不要监听。
 */
export const DATA_CHANGED_EVENT = 'worklife:data-changed'

export type ChangedModule = 'plan' | 'memo' | 'review' | 'learning' | 'reading' | 'app'

/** 通知一次数据变更 */
export function notifyDataChanged(module: ChangedModule): void {
  try {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { module } }))
  } catch {
    /* 事件派发失败不影响主流程 */
  }
}

/** 订阅数据变更，返回取消订阅函数 */
export function subscribeDataChanged(handler: (module: ChangedModule | null) => void): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ module?: ChangedModule }>).detail
    handler(detail?.module ?? null)
  }
  window.addEventListener(DATA_CHANGED_EVENT, listener)
  return () => window.removeEventListener(DATA_CHANGED_EVENT, listener)
}
