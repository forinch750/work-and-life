/**
 * 导航定义（PRD §2.2 / DEVPLAN 阶段 2）
 *
 * 界面与测试共用同一份定义，避免"导航项写在两处、改一处漏一处"。
 *
 * 已确认的取舍：
 *   - 高频五项在上，三个待开发模块居中（灰显但可点击），工具性质两项沉底
 *   - 三个待开发模块点击后显示说明卡，不是死链
 */
import type { PlaceholderContent } from './placeholderContent'
import { PLACEHOLDER_CONTENT } from './placeholderContent'

export type NavSection = 'main' | 'planned' | 'tool'

export interface NavItem {
  id: string
  label: string
  section: NavSection
  /** 是否已完成（false 表示"待开发"，灰显但可点击） */
  ready: boolean
  /**
   * 图标（一个字符）。
   *
   * 侧栏**收起后只剩 54px**（决定 6），文字标签全部隐藏，只留图标——
   * 所以图标必须有，且每个导航项各不相同，否则收起后分不清点的是哪个。
   * 用字符而不是图片/字体包：`dependencies` 必须保持为空（不引第三方库），
   * 而这些字符在 Windows 自带的 Segoe UI Symbol 里都有。
   */
  icon: string
  /** 开发计划里排在第几版 */
  plannedVersion?: string
  /** 待开发模块的说明内容 */
  placeholder?: PlaceholderContent
  /** 是否显示数字角标（复习到期数） */
  badge?: 'reviewDue'
  /** 是否显示红点（计划有逾期任务） */
  dot?: 'planOverdue'
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '总览', section: 'main', ready: true, icon: '⌂' },
  { id: 'plan', label: '计划', section: 'main', ready: true, icon: '▦', dot: 'planOverdue' },
  { id: 'learning', label: '学习', section: 'main', ready: true, icon: '▤' },
  { id: 'review', label: '复习', section: 'main', ready: true, icon: '⟳', badge: 'reviewDue' },
  { id: 'reading', label: '读书', section: 'main', ready: true, icon: '▭' },
  { id: 'memo', label: '备忘录', section: 'main', ready: true, icon: '✎' },
  {
    id: 'project',
    label: '项目',
    section: 'planned',
    ready: false,
    icon: '◈',
    plannedVersion: '第二版',
    placeholder: PLACEHOLDER_CONTENT.project
  },
  {
    id: 'research',
    label: '预研',
    section: 'planned',
    ready: false,
    icon: '◇',
    plannedVersion: '第二版',
    placeholder: PLACEHOLDER_CONTENT.research
  },
  {
    id: 'ledger',
    label: '记账',
    section: 'planned',
    ready: false,
    icon: '¥',
    plannedVersion: '第三版',
    placeholder: PLACEHOLDER_CONTENT.ledger
  },
  { id: 'settings', label: '数据与设置', section: 'tool', ready: true, icon: '⚙' }
]

/** 默认进入的页面 */
export const DEFAULT_VIEW_ID = 'home'

export function findNavItem(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id)
}

/** 面向界面的页面标识：导航项 id 或全局搜索 */
export type ViewId = string

export const SEARCH_ITEM = {
  id: 'search',
  label: '搜索',
  shortcut: 'Ctrl+K',
  icon: '⌕'
} as const

/**
 * 侧栏收起时的宽度与展开时的宽度（像素）。
 *
 * 放在共享层：界面（`shell/Sidebar.tsx`）与验收（`main/verify/phase8.ts`）
 * 读同一个数，免得"断言里写死 54、样式改成 56"这种对不上。
 */
export const SIDEBAR_WIDTH = 200
export const SIDEBAR_COLLAPSED_WIDTH = 54
