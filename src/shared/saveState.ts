/**
 * 保存状态（第二轮 BUG-006）
 *
 * 问题：以前编辑完只有一个"已保存"的临时文案，用户不知道
 *       是刚提交给了主进程、还是真的落盘了、还是失败了。
 *
 * 做法：所有写操作（add / update / remove / flush）都经过同一套状态机，
 *       于是每个编辑区都能显示同一套状态：
 *         idle    什么都没发生
 *         saving  正在保存
 *         saved   已保存
 *         error   保存失败（附带原因，界面必须显示出来）
 *
 * 注意"已保存"的语义：主进程是防抖落盘（默认 300ms 合并、2s 上限），
 * 这里确认的是"主进程已收下这次改动"，不是"已经写到磁盘上"。
 * 磁盘写入由主进程负责，失败会通过 onWriteError 记入日志。
 *
 * 设计说明：计算部分（下方纯函数）与 React 绑定（saveState.ts 的 hook）分开，
 * 这样状态流转能在 node 环境里单测——本项目不引入 jsdom / testing-library，
 * 组件行为统一交给端到端验收。
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** "已保存"提示保留多久（毫秒），然后回到 idle */
export const SAVED_HINT_MS = 1600

export interface SaveStatus {
  state: SaveState
  /** 失败原因；非失败状态为 null */
  error: string | null
}

export const INITIAL_SAVE_STATUS: SaveStatus = { state: 'idle', error: null }

/** 开始一次保存 */
export function beginSave(): SaveStatus {
  return { state: 'saving', error: null }
}

/** 保存成功 */
export function succeedSave(): SaveStatus {
  return { state: 'saved', error: null }
}

/**
 * 把任意抛出物整理成可读文本。
 * 与 src\main\data\logger.ts 的 describeError 保持同一策略：
 * Error 取 message，字符串直接用，其余先试 JSON 再退到 String——
 * 直接 String(对象) 会得到 "[object Object]"，等于没说。
 */
export function describeSaveFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  try {
    const json = JSON.stringify(reason)
    if (typeof json === 'string' && json !== '') return json
  } catch {
    /* 循环引用等无法序列化的情况，落到下面的兜底 */
  }
  return String(reason)
}

/** 保存失败：必须带上原因，否则界面只能干说"失败了" */
export function failSave(reason: unknown): SaveStatus {
  const detail = describeSaveFailure(reason)
  return { state: 'error', error: detail === '' ? '未知原因' : detail }
}

/** 回到 idle（提示消失、关闭抽屉等） */
export function idleSave(): SaveStatus {
  return { state: 'idle', error: null }
}

/** 是否处于"还要显示点什么"的状态 */
export function isBusy(status: SaveStatus): boolean {
  return status.state === 'saving'
}

/** 是否成功过（用于决定要不要自动回到 idle） */
export function shouldAutoReset(status: SaveStatus): boolean {
  return status.state === 'saved'
}

/** 状态 → 给人看的中文文案 */
export const SAVE_STATE_LABELS: Record<SaveState, string> = {
  idle: '',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败'
}

/**
 * 供界面统一渲染的提示文本。
 * 失败时带上原因——只显示"保存失败"而不说为什么，等于没说。
 */
export function saveStateText(status: SaveStatus): string {
  if (status.state === 'error') {
    return `${SAVE_STATE_LABELS.error}：${status.error ?? '未知原因'}`
  }
  return SAVE_STATE_LABELS[status.state]
}
