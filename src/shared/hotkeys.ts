/**
 * 快捷键的**语义与展示**（第二轮 FEAT-008）
 *
 * 与 `renderer\lib\hotkeys.ts` 的分工：
 *   - `renderer\lib\hotkeys.ts` = **框架**：把键盘事件归一成组合键、判断"焦点在输入框里"、
 *     注册监听。它不认识任何业务动作。
 *   - 本文件 = **语义**：哪个动作叫什么、哪个页面支持哪个动作、组合键怎么显示给人看。
 *     纯函数、不碰 DOM，主进程 / 测试都能用。
 *
 * 已定决定 29（`MASTER.md` §6.6 / §14.6）：
 *   - `N` = 当前模块新建一条：计划 = 新建任务 / 学习 = 新建主题 /
 *     读书 = 添加书籍 / 备忘 = 新建备忘
 *   - `N` **复习页不注册**（复习卡从别处生成，"新建"在复习页没有自然含义）
 *   - `T` = 计划页回到今天（同时把视图切回"今天"），只在计划页生效
 */
import type { HotkeyAction } from './preferences'

/** `N` 在各模块"新建什么" */
export type NewEntryKind = 'task' | 'topic' | 'book' | 'memo'

/** 新建动作的说明（设置页的提示与交接文档共用这一份） */
export const NEW_ENTRY_LABELS: Record<NewEntryKind, string> = {
  task: '计划 = 新建任务',
  topic: '学习 = 新建主题',
  book: '读书 = 添加书籍',
  memo: '备忘 = 新建备忘'
}

/**
 * 页面 → 新建的种类。
 *
 * **刻意不包含 `review`**：复习页按 `N` 必须什么都不发生（决定 29）。
 * 这张表是"哪些页面支持 N"的**唯一来源**，所以"复习页不注册"这件事有单测盯住，
 * 而不是靠"记得别在复习页里加"。
 */
const NEW_ENTRY_BY_VIEW: Record<string, NewEntryKind> = {
  plan: 'task',
  learning: 'topic',
  reading: 'book',
  memo: 'memo'
}

/** 某个页面按 `N` 做什么；`null` 表示这个页面**不注册** `N` */
export function newEntryKindOfView(viewId: string): NewEntryKind | null {
  return NEW_ENTRY_BY_VIEW[viewId] ?? null
}

/** `T` 只在计划页生效 */
export function todayHotkeyAppliesTo(viewId: string): boolean {
  return viewId === 'plan'
}

/** `N` 在设置页上的说明：列出生效的模块，并明写复习页不注册 */
export function newHotkeyHint(): string {
  const parts = (Object.keys(NEW_ENTRY_LABELS) as NewEntryKind[]).map(
    (kind) => NEW_ENTRY_LABELS[kind]
  )
  return `${parts.join(' · ')}；复习页不注册`
}

/** `T` 在设置页上的说明 */
export const TODAY_HOTKEY_HINT = '计划页回到今天，并把视图切回「今天」；其它页面不起作用'

/** 动作在设置页上的补充说明（没有就不显示提示） */
export function hotkeyHint(action: HotkeyAction): string | null {
  if (action === 'new') return newHotkeyHint()
  if (action === 'today') return TODAY_HOTKEY_HINT
  return null
}

/** 特殊键的显示写法 */
const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: '回车',
  space: '空格',
  tab: 'Tab'
}

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta'
}

/**
 * 组合键的显示写法：`ctrl+s` → `Ctrl+S`、`escape` → `Esc`、`n` → `N`。
 *
 * 界面上显示的是"键盘上印的字"，落库用的是 `renderer\lib\hotkeys.ts` 的小写写法——
 * 两者刻意分开：显示可以随便美化，绑定值必须与 `comboFromEvent` 严格一致。
 */
export function comboLabel(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return ''
  const key = parts[parts.length - 1] ?? ''
  const modifiers = parts.slice(0, -1).map((part) => MODIFIER_LABELS[part] ?? part)
  const keyLabel = KEY_LABELS[key] ?? key.toUpperCase()
  return [...modifiers, keyLabel].join('+')
}

/**
 * 固定快捷键（不可改）。
 *
 * 这几条是**操作姿势**而不是"我的习惯"：空格 = 显示答案、1/2/3 = 三档评分、
 * Esc = 退出/关闭、Ctrl+回车 = 保存。它们与复习与编辑的手感绑在一起，
 * 允许改反而会把用户指南写死的那套操作拆散，所以只在设置页**列出来**、不提供修改。
 */
export interface FixedHotkey {
  combo: string
  label: string
  scope: string
}

export const FIXED_HOTKEYS: FixedHotkey[] = [
  { combo: 'space', label: '显示答案', scope: '复习页 / 就地背卡' },
  { combo: '1', label: '忘了（1 天后）', scope: '复习页 / 就地背卡' },
  { combo: '2', label: '有点模糊（3 天后）', scope: '复习页 / 就地背卡' },
  { combo: '3', label: '记住了（7 天起逐级放大）', scope: '复习页 / 就地背卡' },
  { combo: 'escape', label: '退出复习 / 关掉抽屉与对话框', scope: '全局' },
  { combo: 'ctrl+enter', label: '保存（多行输入区）', scope: '快速记一笔 / 备忘 / 表格里' }
]
