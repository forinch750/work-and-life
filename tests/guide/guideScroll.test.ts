/**
 * 第 07 块：目录 ↔ 正文滚动联动的纯逻辑（`docs\TASKS\07` §5.4 "目录能看出当前停在哪一章"）
 *
 * 这两条算法决定"目录指着哪一章"，而它在界面上很难用肉眼看准
 * （滚到章与章的接缝、滚到最底、最后一章比容器还矮——三种情况都能让目录乱跳）。
 * 所以把边界钉在这里，组件里只剩"量偏移 + 调函数"。
 */
import { describe, expect, it } from 'vitest'
import {
  CHAPTER_ACTIVE_MARGIN,
  chapterAt,
  scrollTopForChapter
} from '../../src/renderer/modules/settings/guideScroll'

/** 七章的典型偏移（第一份正文的真实量级：章节越往后越长） */
const OFFSETS = [0, 320, 940, 1420, 1880, 2360, 3100]
const MAX_SCROLL = 2900

describe('chapterAt：现在停在第几章', () => {
  it('刚打开（scrollTop = 0）停在第一章', () => {
    expect(chapterAt(OFFSETS, 0, MAX_SCROLL)).toBe(0)
  })

  it('越过某一章的顶端就算停在这一章', () => {
    expect(chapterAt(OFFSETS, 320, MAX_SCROLL)).toBe(1)
    expect(chapterAt(OFFSETS, 500, MAX_SCROLL)).toBe(1)
    expect(chapterAt(OFFSETS, 940, MAX_SCROLL)).toBe(2)
    expect(chapterAt(OFFSETS, 2360, MAX_SCROLL)).toBe(5)
  })

  it('差一点点没到下一章时，仍算上一章（否则目录会在接缝上来回跳）', () => {
    expect(chapterAt(OFFSETS, 939 - 40, MAX_SCROLL)).toBe(1)
  })

  it('判据带容差：标题刚好贴住容器顶部也算这一章', () => {
    expect(chapterAt(OFFSETS, 320 - CHAPTER_ACTIVE_MARGIN, MAX_SCROLL)).toBe(1)
    expect(chapterAt(OFFSETS, 320 - CHAPTER_ACTIVE_MARGIN - 5, MAX_SCROLL)).toBe(0)
  })

  it('滚到底就停在最后一章（最后一章常常比容器矮，顶不到顶部）', () => {
    // 最后一章的偏移 3100 已经超过可滚上限 2900：按"顶端越过顶部"永远算不到它
    expect(chapterAt(OFFSETS, MAX_SCROLL, MAX_SCROLL)).toBe(OFFSETS.length - 1)
    expect(chapterAt(OFFSETS, MAX_SCROLL - 1, MAX_SCROLL)).toBe(OFFSETS.length - 1)
    // 离底部还有一截时仍按正常规则算
    expect(chapterAt(OFFSETS, MAX_SCROLL - 200, MAX_SCROLL)).toBe(5)
  })

  it('内容不够高（不能滚）时永远停在第一章，不会算出越界下标', () => {
    expect(chapterAt(OFFSETS, 0, 0)).toBe(0)
    expect(chapterAt([], 0, 0)).toBe(0)
  })
})

describe('scrollTopForChapter：点目录时滚到哪', () => {
  it('滚到目标章顶端，并留出与判据一致的容差', () => {
    expect(scrollTopForChapter(OFFSETS, 2, MAX_SCROLL)).toBe(940 - CHAPTER_ACTIVE_MARGIN)
    expect(scrollTopForChapter(OFFSETS, 0, MAX_SCROLL)).toBe(0)
  })

  it('最后一章滚不到顶端时夹到可滚上限（返回值就是真正会到达的值）', () => {
    expect(scrollTopForChapter(OFFSETS, 6, MAX_SCROLL)).toBe(MAX_SCROLL)
    // 夹住之后，目录必须还指着最后一章
    expect(chapterAt(OFFSETS, scrollTopForChapter(OFFSETS, 6, MAX_SCROLL), MAX_SCROLL)).toBe(6)
  })

  it('越界下标被夹回合法范围（不会滚到负数或 NaN）', () => {
    expect(scrollTopForChapter(OFFSETS, -3, MAX_SCROLL)).toBe(0)
    expect(scrollTopForChapter(OFFSETS, 99, MAX_SCROLL)).toBe(MAX_SCROLL)
    expect(scrollTopForChapter([], 2, MAX_SCROLL)).toBe(0)
    expect(scrollTopForChapter(OFFSETS, 2, 0)).toBe(0)
  })

  it('点任何一章之后，目录都会正好停在这一章（两函数互为逆）', () => {
    for (let index = 0; index < OFFSETS.length; index += 1) {
      const top = scrollTopForChapter(OFFSETS, index, MAX_SCROLL)
      expect(chapterAt(OFFSETS, top, MAX_SCROLL)).toBe(index)
    }
  })
})
