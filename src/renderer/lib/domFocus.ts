/**
 * 把焦点放到某个 `data-testid` 的元素上（第二轮 FEAT-008 的 `N` 用到）。
 *
 * 为什么按 testId 找而不是传 ref：
 *   - "新建"的入口本来就散在各页内部（计划的表单、学习的行内输入、备忘的富文本区），
 *     为了一个快捷键把 ref 一层层往下传，会把页面组件绑死成"必须暴露内部节点"。
 *   - 验收台也是按 testId 找元素的，两处口径一致，改 testId 时看得见。
 *
 * 找不到元素不算错：页面还没挂载好、或这个页面本来没有"新建输入区"时，
 * 按 `N` 就该什么都不发生，不该抛错。
 */
export function focusByTestId(testId: string): boolean {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!element) return false
  element.focus()
  return document.activeElement === element
}
