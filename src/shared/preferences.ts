/**
 * 偏好设置（DEVPLAN 阶段 3 / PRD §5.7）
 *
 * 存放位置：data\app.json 里 id 固定为 "preferences" 的那一条记录。
 * 放在数据文件里而不是浏览器 localStorage，理由：
 *   - 跟着数据走：整个文件夹拷到另一台电脑，偏好也跟着过去
 *   - 导出的备份里包含偏好，恢复后不用重新设置
 */
import type { DataModule } from './modules'
import { DEFAULT_TRASH_KEEP_DAYS, TRASH_KEEP_FOREVER_DAYS } from './trash'

export type ThemePreference = 'system' | 'light' | 'dark'
export type WeekStart = 1 | 7
export type ReviewIntensity = 'standard' | 'relaxed' | 'intense'

/**
 * 可绑定的快捷键动作（FEAT-008）。
 *
 * 绑定值用 `renderer\lib\hotkeys.ts` 的组合键写法：`ctrl+s` / `n` / `escape`，
 * 修饰键顺序固定 ctrl → alt → shift → meta，主键小写。
 */
export type HotkeyAction =
  | 'save'
  | 'new'
  | 'today'
  | 'search'
  | 'review'
  | 'memo'
  | 'plan'
  | 'learning'
  | 'reading'

/**
 * 动作的显示名（设置页列出全部快捷键时用）。
 *
 * `memo` 的显示名是"快速记一笔"而不是"切到备忘录"：它的默认绑定
 * `Ctrl+Alt+M` 是 PRD §2.5 定下的**快速记一笔**（结果落到备忘模块），
 * 名字必须与真实行为一致，否则设置页就是在骗人。
 */
export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  save: '手动保存',
  new: '当前模块新建一条',
  today: '计划页回到今天',
  search: '全局搜索',
  review: '切到复习',
  memo: '快速记一笔（备忘）',
  plan: '切到计划',
  learning: '切到学习',
  reading: '切到读书'
}

/**
 * 默认绑定。`N` / `T` 的语义已定（MASTER §6.6）：
 *   N = 当前模块新建一条（**复习页不注册**，那儿没有"新建"的自然含义）
 *   T = 计划页回到今天（同时把视图切回"今天"）
 */
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  save: 'ctrl+s',
  new: 'n',
  today: 't',
  search: 'ctrl+k',
  review: 'ctrl+alt+r',
  memo: 'ctrl+alt+m',
  plan: 'ctrl+alt+p',
  learning: 'ctrl+alt+l',
  reading: 'ctrl+alt+b'
}

export interface AppPreferences {
  theme: ThemePreference
  weekStart: WeekStart
  reviewIntensity: ReviewIntensity
  /** 备份保留份数 */
  backupKeepDays: number
  /**
   * 回收站保留天数（第二轮 FEAT-009）。
   * 达到 TRASH_KEEP_FOREVER_DAYS 视为永久保留；7 / 30 / 永久 / 自定义。
   * 缺省 30 天——老数据没有这个字段时也按 30 天处理，不需要改数据。
   */
  trashKeepDays: number
  /**
   * 快捷键绑定（FEAT-008），跟着数据走。
   *
   * **只有被改过的动作才出现在这里**；缺省的动作取 DEFAULT_HOTKEYS。
   * 这样旧数据（整个字段都没有）与"只改了一个键"的新数据是同一套读取逻辑。
   */
  hotkeys?: Partial<Record<HotkeyAction, string>>
  /**
   * 侧栏是否收起（第 08 块 · 决定 6）。
   *
   * 与 `hotkeys` 同一个套路：**只在收起时写这个字段**，展开时不写。
   * 这样老数据（整个字段没有）天然等于"展开"，`normalizePreferences` 也不必
   * 往结果里塞一个新的默认字段（那会让"合法输入原样通过"那条单测变红）。
   */
  sidebarCollapsed?: boolean
  /**
   * 复习页左栏里**被隐藏**的主题（修改 2 轮 · 2026-10）。
   *
   * 用户原话：「复习无法删除主题。」被隐藏的是复习的"主题"——
   * 它可能是学习主题、读书的书，也可能是**来源档**（卡片原来的主题/书
   * 已经不存在时按来源名自成一档）。来源档不是真实实体，没法用"删学习主题"
   * 的方式处置，隐藏是对这类最合适的做法。
   *
   * ## 为什么存偏好而不是存复习数据
   *
   * 这是"这个人的查看偏好"，不是卡片数据：卡片、学习主题、书**一个都不动**。
   * 存偏好还带来一个好处——跟着数据走（换电脑带走、备份恢复后还在）。
   *
   * ## ⚠️ 隐藏**绝不能**造成漏复习（`MASTER.md` 决定 19 / R1）
   *
   * 隐藏只影响左栏列表的显示：汇总横条的总数、分布、汇总复习按钮、导航角标
   * **一个数都不变**，被隐藏主题的到期卡照样会被「汇总复习」抽到。
   * 所以这个字段只用来过滤列表，**任何"算总数"的地方都不许读它**。
   *
   * 缺省（老数据没有这个字段）= 没有任何隐藏。
   */
  reviewHiddenTopicIds?: string[]
  /**
   * 逾期提醒（计划页工具栏里的内联小提示）**被关掉的那一天**（修改 6 轮）。
   *
   * 用户原话：「这个提醒放在上面按个框框里，然后可以关闭。」
   * 定的口径是"**当天不再出现**"：关掉就今天不再显示；第二天有逾期又会出来。
   *
   * ## 为什么存日期字符串而不是布尔
   *
   * 存布尔会变成"永久关掉"，与"第二天有逾期又会出来"不符；
   * 存"哪一天关的"才能只用一个 `!== 今天` 的判断实现按天失效，
   * **不需要任何定时器**（第二天的时间一到，条件自然就不成立了）。
   *
   * 缺省（老数据没有这个字段）= 没关过 = 正常显示；旧记录零改写、**不需要迁移**。
   * 它**只管那条提示**：页头「逾期 N 项」统计、关注卡、导航红点都不读它。
   */
  overdueHintDismissedOn?: string
}

/** 偏好记录的固定 id 与所在模块 */
export const PREFERENCES_ID = 'preferences'
export const PREFERENCES_MODULE: DataModule = 'app'

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'system',
  weekStart: 1,
  reviewIntensity: 'standard',
  backupKeepDays: 30,
  trashKeepDays: DEFAULT_TRASH_KEEP_DAYS
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isIntensity(value: unknown): value is ReviewIntensity {
  return value === 'standard' || value === 'relaxed' || value === 'intense'
}

/** 备份保留份数的合理范围：1–365 */
export function clampKeepDays(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_PREFERENCES.backupKeepDays
  return Math.min(365, Math.max(1, Math.round(parsed)))
}

/**
 * 回收站保留天数的合理范围：1 天 ~ 永久。
 * 上限用 TRASH_KEEP_FOREVER_DAYS，超过它就统一按"永久保留"处理。
 */
export function clampTrashKeepDays(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TRASH_KEEP_DAYS
  return Math.min(TRASH_KEEP_FOREVER_DAYS, Math.max(1, Math.round(parsed)))
}

/**
 * 组合键写法的合法检查：`ctrl+alt+shift+meta` 若干 + 一个主键。
 * 与 `renderer\lib\hotkeys.ts` 的 `comboFromEvent` 保持同一套写法，
 * 但**不依赖渲染进程**——主进程与测试都要能用。
 */
const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const

export function isValidCombo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('+')
  if (parts.length === 0 || parts.some((part) => part === '')) return false
  const key = parts[parts.length - 1] ?? ''
  const modifiers = parts.slice(0, -1)
  if (modifiers.some((part) => !(MODIFIERS as readonly string[]).includes(part))) return false
  if (new Set(modifiers).size !== modifiers.length) return false
  return /^[a-z0-9]$/.test(key) || ['escape', 'enter', 'space', 'tab'].includes(key)
}

/** 归一化组合键写法：小写、修饰键按固定顺序（ctrl → alt → shift → meta） */
export function normalizeCombo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return null

  const key = parts[parts.length - 1] ?? ''
  // 修饰键必须**已经在规范顺序上**（ctrl → alt → shift → meta）。
  // 检查的是"严格递增的子序列"而不是"完整前缀"：
  //   'ctrl+shift+s' 合法（跳过 alt 是常见写法，Ctrl+Shift+S 本来就是保存为）
  //   'shift+ctrl+s' 拒绝（乱序，不悄悄改写用户填的东西）
  //   'alt+ctrl+s'   拒绝（乱序）
  //   'ctrl+ctrl+s'  拒绝（重复，不能被去重成合法的 'ctrl+s' 蒙混过关）
  const modifiers = parts.slice(0, -1)
  let lastIndex = -1
  for (const modifier of modifiers) {
    const at = MODIFIERS.indexOf(modifier as (typeof MODIFIERS)[number])
    if (at < 0 || at <= lastIndex) return null
    lastIndex = at
  }

  const combo = [...modifiers, key].join('+')
  return isValidCombo(combo) ? combo : null
}

/**
 * 完整绑定表：默认值打底，用户改过的覆盖上去。
 * 非法值一律忽略（回退默认），绝不因为一个坏绑定让整份偏好不可用。
 */
export function resolveHotkeys(
  overrides: Partial<Record<HotkeyAction, string>> | undefined
): Record<HotkeyAction, string> {
  const result = { ...DEFAULT_HOTKEYS }
  if (!overrides) return result
  for (const action of Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]) {
    const combo = normalizeCombo(overrides[action])
    if (combo !== null) result[action] = combo
  }
  return result
}

/** 只保留"与默认值不同"的绑定，落库用 */
export function hotkeyOverrides(
  bindings: Record<HotkeyAction, string>
): Partial<Record<HotkeyAction, string>> {
  const out: Partial<Record<HotkeyAction, string>> = {}
  for (const action of Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]) {
    const combo = normalizeCombo(bindings[action])
    if (combo === null || combo === DEFAULT_HOTKEYS[action]) continue
    out[action] = combo
  }
  return out
}

/** 冲突检查：某个组合键被哪些动作占用（多于一个即冲突） */
export function comboConflicts(
  bindings: Record<HotkeyAction, string>,
  combo: string
): HotkeyAction[] {
  const target = normalizeCombo(combo)
  if (target === null) return []
  return (Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]).filter((action) => {
    const current = normalizeCombo(bindings[action])
    return current !== null && current === target
  })
}

/** 全部动作（顺序固定 = DEFAULT_HOTKEYS 的书写顺序，设置页按它列） */
export const HOTKEY_ACTIONS: HotkeyAction[] = Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]

/** 改绑的结果：失败时 `bindings` 原样返回，`error` 里是要显示给用户的原因 */
export interface HotkeyAssignResult {
  bindings: Record<HotkeyAction, string>
  /** 改绑后的绑定值（规范化后的写法）；失败时为 null */
  combo: string | null
  error: string | null
}

/**
 * 把一个动作改绑到某个组合键（纯函数，设置页只负责显示）。
 *
 * 三条拒绝规则，缺一条都会让快捷键变得不可用：
 *   1. 写法非法（例如只有修饰键、`shift+ctrl+s` 这种乱序）→ 拒绝并说明
 *   2. 被**别的动作**占用 → 拒绝。同一动作重复绑自己没有意义，但也不算冲突
 *   3. 与自己的旧值相同 → 直接成功（幂等，不报"冲突自己"）
 */
export function assignHotkey(
  bindings: Record<HotkeyAction, string>,
  action: HotkeyAction,
  combo: unknown,
  labelOf: (action: HotkeyAction) => string = (item) => HOTKEY_LABELS[item]
): HotkeyAssignResult {
  const normalized = normalizeCombo(combo)
  if (normalized === null) {
    return { bindings, combo: null, error: '这个按键组合用不了：需要「主键」或「Ctrl/Alt/Shift + 主键」' }
  }
  const taken = comboConflicts(bindings, normalized).filter((item) => item !== action)
  if (taken.length > 0) {
    const names = taken.map((item) => `「${labelOf(item)}」`).join('、')
    return { bindings, combo: null, error: `冲突：这个键已经被${names}占用` }
  }
  return { bindings: { ...bindings, [action]: normalized }, combo: normalized, error: null }
}

/** 把某一个动作恢复成默认绑定（纯函数） */
export function resetHotkeyAction(
  bindings: Record<HotkeyAction, string>,
  action: HotkeyAction
): Record<HotkeyAction, string> {
  return { ...bindings, [action]: DEFAULT_HOTKEYS[action] }
}

/** 全部恢复默认绑定（纯函数） */
export function resetAllHotkeys(): Record<HotkeyAction, string> {
  return { ...DEFAULT_HOTKEYS }
}

/** 某个动作当前是否用的默认绑定（设置页据此决定"重置"按钮是否可点） */
export function isDefaultHotkey(
  bindings: Record<HotkeyAction, string>,
  action: HotkeyAction
): boolean {
  return normalizeCombo(bindings[action]) === DEFAULT_HOTKEYS[action]
}

/** 一份绑定里全部重复占用（正常状态下应当为空数组） */
export function hotkeyConflictGroups(
  bindings: Record<HotkeyAction, string>
): Array<{ combo: string; actions: HotkeyAction[] }> {
  const byCombo = new Map<string, HotkeyAction[]>()
  for (const action of HOTKEY_ACTIONS) {
    const combo = normalizeCombo(bindings[action])
    if (combo === null) continue
    const list = byCombo.get(combo) ?? []
    list.push(action)
    byCombo.set(combo, list)
  }
  const out: Array<{ combo: string; actions: HotkeyAction[] }> = []
  for (const [combo, actions] of byCombo) {
    if (actions.length > 1) out.push({ combo, actions })
  }
  return out
}

/** 从任意输入里解析出绑定覆盖（容忍非法值） */
export function normalizeHotkeys(value: unknown): Partial<Record<HotkeyAction, string>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const out: Partial<Record<HotkeyAction, string>> = {}
  for (const action of Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]) {
    const combo = normalizeCombo(raw[action])
    if (combo !== null) out[action] = combo
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 把任意输入清洗成"隐藏了哪些复习主题"。
 *
 * 三条规矩，一条都不能少（这个字段来自磁盘，也可能是用户手改的 JSON）：
 *   1. **不是数组 → 当没有**（不抛错）
 *   2. **不是字符串 / 空串的成员一律丢掉**（不抛错）
 *   3. **去重**，并保持原来的顺序（顺序影响"显示已隐藏"里的排列）
 *
 * 洗完之后是空数组就返回 `undefined`（= 没有任何隐藏），
 * 这样"合法输入原样通过"那条单测仍然成立，旧数据也不必凭空多一个字段。
 */
export function normalizeHiddenTopicIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把任意输入规范成"某一天"（YYYY-MM-DD）或 `undefined`。
 *
 * 这个字段来自磁盘，也可能是用户手改的 JSON，所以三步都要做：
 *   1. 不是字符串 / 形状不对 → `undefined`（**不抛错**）
 *   2. 日期必须真实存在（`2026-02-30` / `2026-13-01` 一律清掉）
 *   3. 合法就原样返回（不做时区换算——它只是"哪一天关的"这个标签）
 */
function normalizeDateKeyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  const probe = new Date(year, month - 1, day)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return undefined
  }
  return value
}

/**
 * 把任意输入规范成合法偏好。
 * 单项非法时回退到默认值，绝不因为一个坏字段就让整份偏好不可用。
 */
export function normalizePreferences(input: unknown): AppPreferences {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_PREFERENCES }
  const raw = input as Partial<Record<keyof AppPreferences, unknown>>
  const hotkeys = normalizeHotkeys(raw.hotkeys)
  const hiddenTopics = normalizeHiddenTopicIds(raw.reviewHiddenTopicIds)
  const overdueDismissedOn = normalizeDateKeyString(raw.overdueHintDismissedOn)
  return {
    theme: isTheme(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme,
    weekStart: raw.weekStart === 7 ? 7 : 1,
    reviewIntensity: isIntensity(raw.reviewIntensity)
      ? raw.reviewIntensity
      : DEFAULT_PREFERENCES.reviewIntensity,
    backupKeepDays: clampKeepDays(raw.backupKeepDays),
    trashKeepDays: clampTrashKeepDays(raw.trashKeepDays),
    ...(hotkeys ? { hotkeys } : {}),
    // 只认严格的 `true`：`"true"` / `1` / `"yes"` 一律算"没收起"，
    // 宁可展开也不要把侧栏收起来让人找不到导航
    ...(raw.sidebarCollapsed === true ? { sidebarCollapsed: true } : {}),
    // 同上：只在**真的隐藏了东西**时才写这个字段（空数组 = 没有隐藏，不写）
    ...(hiddenTopics ? { reviewHiddenTopicIds: hiddenTopics } : {}),
    // 逾期提醒：只在"确实关过某一天"时才写；脏数据当成没关过（缺省 = 正常显示）
    ...(overdueDismissedOn ? { overdueHintDismissedOn: overdueDismissedOn } : {})
  }
}

/** 从记录列表里取出偏好（找不到就返回默认值） */
export function readPreferences(records: Array<Record<string, unknown>>): AppPreferences {
  const found = records.find((record) => record['id'] === PREFERENCES_ID)
  if (!found) return { ...DEFAULT_PREFERENCES }
  return normalizePreferences(found)
}

/** 复习间隔倍率：宽松更慢、密集更快 */
export function intensityMultiplier(intensity: ReviewIntensity): number {
  if (intensity === 'relaxed') return 1.5
  if (intensity === 'intense') return 0.6
  return 1
}

/** 把任意输入收敛成合法的复习强度 */
export function effectiveIntensity(value: unknown): ReviewIntensity {
  return isIntensity(value) ? value : DEFAULT_PREFERENCES.reviewIntensity
}

// ===========================================================================
// 侧栏收起状态（第 08 块 · 决定 6）
// ===========================================================================

/** 现在是否收起。缺省（老数据没有这个字段）= false = 展开 */
export function isSidebarCollapsed(prefs: AppPreferences): boolean {
  return prefs.sidebarCollapsed === true
}

/**
 * 切换侧栏：返回要写进偏好的那**一个字段**。
 *
 * 展开时返回 `{ sidebarCollapsed: false }` 而不是"什么都不写"：
 * 落库用的是 `api.update` 的合并语义，必须显式写 false 才能把 true 改回来。
 */
export function toggleSidebarCollapsed(prefs: AppPreferences): Partial<AppPreferences> {
  return { sidebarCollapsed: !isSidebarCollapsed(prefs) }
}
