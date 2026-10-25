/**
 * 「操作指南」目录 ↔ 正文的滚动联动（第 07 块 / `docs\TASKS\07` §5.4）
 *
 * 只有两条算法：
 *   - `chapterAt`：给定各章在滚动容器里的纵向偏移与当前 `scrollTop`，
 *     判断"用户现在停在哪一章"（目录靠它决定哪一项是当前项）
 *   - `scrollTopForChapter`：点了目录里的某一章，正文该滚到哪里
 *
 * 为什么抽成纯函数：这两件事只在界面上"看起来对不对"，很容易写成
 * "滚到章与章的接缝时目录乱跳"或"点最后一章没反应"。抽出来以后能在
 * `tests\guide\guideScroll.test.ts` 里把边界钉住（滚到底 / 最后一章比容器矮 /
 * 空目录），组件里就只剩"量偏移 → 调这两个函数"。
 */

/**
 * 判据里的容差：目录点击会把标题滚到离容器顶部 `margin` 处，
 * 判断"当前章"时也要留同样的容差，否则点完立刻会被算成上一章。
 */
export const CHAPTER_ACTIVE_MARGIN = 12

/**
 * 现在停在第几章（返回章下标，`offsets` 为空时返回 0）。
 *
 * 两条规则：
 *   1. 正常情况 = **最后一个"顶端已经越过容器顶部"的章**
 *   2. 滚到底 = 最后一章。最后一章常常比容器还矮，永远顶不到容器顶部；
 *      不特判的话用户滚到底、目录却指着倒数第二章。
 */
export function chapterAt(
  offsets: number[],
  scrollTop: number,
  maxScroll: number,
  margin: number = CHAPTER_ACTIVE_MARGIN
): number {
  if (offsets.length === 0) return 0
  if (maxScroll > 0 && scrollTop >= maxScroll - 2) return offsets.length - 1

  let active = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index] ?? 0
    if (offset <= scrollTop + margin) active = index
    else break
  }
  return active
}

/**
 * 点目录里的第 `index` 章时，正文该滚到哪。
 *
 * 结果夹在 `[0, maxScroll]`：最后一章的偏移常常大于可滚上限，
 * 直接拿它去 `scrollTo` 会被浏览器夹住，这里先夹好再返回，
 * 保证"返回的值 = 真的会到达的值"（端到端才好断言）。
 */
export function scrollTopForChapter(
  offsets: number[],
  index: number,
  maxScroll: number,
  margin: number = CHAPTER_ACTIVE_MARGIN
): number {
  if (offsets.length === 0 || maxScroll <= 0) return 0
  const clampedIndex = Math.min(Math.max(index, 0), offsets.length - 1)
  const target = (offsets[clampedIndex] ?? 0) - margin
  return Math.min(Math.max(target, 0), maxScroll)
}
