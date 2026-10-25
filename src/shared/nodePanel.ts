/**
 * 树行的**两层展开状态**：子节点展开 vs 就地面板（2026-10 修订）
 *
 * ## 为什么拆成两个
 *
 * 以前"这个节点的子节点展开着"和"这个节点的就地面板开着"共用**一个**数组
 * （`LearningPage` 的 `expandedNodeIds` / `ReadingPage` 的 `expandedChapterIds`），
 * 于是用户遇到三个问题（验收后提出："**这个无法收起**"）：
 *
 *   1. **面板里没有「收起」**——没人看得出来"再点一次这一行"能收
 *   2. **有子节点的章节想收面板、但保留子节点展开 → 做不到**（一个状态管两件事）
 *   3. **反过来收子节点，面板也一起消失**
 *
 * 所以拆开：
 *
 *   - `expandedIds` **数组**：子节点露不露。**必须留数组**——
 *     树是层数不限的，要看到第 6 层得让 1→2→3→4→5 整条祖先链同时展开；
 *     改成单值的话点开下一层会把上一层收起来，深层永远显示不出来（已踩过）。
 *   - `openPanelId` **单值**：同屏只开一个面板，点另一行就换过去（上一块自动收起）。
 *
 * ## 谁调它
 *
 * `modules/learning/LearningPage.tsx` 与 `modules/reading/ReadingPage.tsx` 各用一个
 * `useState<NodePanelState>`，所有改动都经过这里的纯函数——
 * 两页的收起行为因此**天然一致**（§6.4 第 6 条：别一个用 `×`、一个用文字）。
 * 纯逻辑在这里，所以"点行→开 / 再点→收 / 点另一行→换 / 拆开后互不影响"
 * 这五条能在 `tests/shell/nodePanel.test.ts` 里逐条钉死
 * （vitest 是 `environment: 'node'`，**没有 jsdom**，组件本身由端到端覆盖）。
 */

export interface NodePanelState {
  /** 子节点展开集合（数组：祖先链要能同时展开） */
  expandedIds: string[]
  /** 当前摊开就地面板的那一行（null = 都收着） */
  openPanelId: string | null
}

export const EMPTY_NODE_PANEL_STATE: NodePanelState = { expandedIds: [], openPanelId: null }

/** 点行（`onOpenDetail`）：同一行 → 收起；另一行 → 换过去（上一块自动收起） */
export function toggleOpenPanel(state: NodePanelState, id: string): NodePanelState {
  return { ...state, openPanelId: state.openPanelId === id ? null : id }
}

/** 收面板（面板里的「收起」按钮、`Esc`）——**不动子节点** */
export function closeOpenPanel(state: NodePanelState): NodePanelState {
  return state.openPanelId === null ? state : { ...state, openPanelId: null }
}

/** 展开 / 收起子节点（箭头、汇总行点击、菜单里的"展开 / 折叠"）——**不动面板** */
export function setExpanded(state: NodePanelState, id: string, next: boolean): NodePanelState {
  const has = state.expandedIds.includes(id)
  // 状态没变就返回原对象：少一次无意义的重渲染，也不会把引用白白换掉
  if (next === has) return state
  return {
    ...state,
    expandedIds: next
      ? [...state.expandedIds, id]
      : state.expandedIds.filter((item) => item !== id)
  }
}

/** 切换子节点展开状态 */
export function toggleExpanded(state: NodePanelState, id: string): NodePanelState {
  return setExpanded(state, id, !state.expandedIds.includes(id))
}

/** 子节点是不是展开着 */
export function isExpanded(state: NodePanelState, id: string): boolean {
  return state.expandedIds.includes(id)
}

/** 面板是不是开在这一行上 */
export function isPanelOpen(state: NodePanelState, id: string): boolean {
  return state.openPanelId === id
}

/**
 * 传给 `TreeView` 的 `openDetailIds`。
 *
 * 组件要的是数组（它内部按 `Set` 用），而这里语义上只有一个——
 * 转换放在这里，页面就不用各写一次 `panel === null ? [] : [panel]`。
 */
export function openDetailIdsOf(state: NodePanelState): string[] {
  return state.openPanelId === null ? [] : [state.openPanelId]
}
