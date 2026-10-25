/**
 * 学习页视图计算的单测（`docs\TASKS\09` §7.2）
 *
 * 本块要新增的三条断言：
 *   1. **学习页进度** —— 与 08 块的公共实现（`shared/treeProgress.ts`）**结果一致**，
 *      并且资料行上的两个数字都算对（`占比 50% · 已学 43%（3/7）`）
 *   2. **缩进规则** —— 第 4 层仍是 20px，第 5 层起 12px（学习页用的是同一份实现）
 *   3. **进度为 0 / 100 的边界** —— 不崩、显示正确
 *
 * 写法上刻意保留一份**照着 `MASTER.md` §7.9 文字独立实现**的参考实现（`referencePercent`），
 * 它不复用被测代码的任何一行：谁以后图快在页面里另写一段加权平均，这里就会红。
 *
 * 环境是 `environment: 'node'`（没有 jsdom，也不许为测组件引 jsdom）：
 * 组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-S1…S10）。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeLearningRecord,
  type LearningLog,
  type LearningNode
} from '../../src/shared/learning'
import {
  chapterProgressText,
  clampTargetDays,
  isTopicEntered,
  nodesOfTopic,
  recordLineText,
  resourceCardMeta,
  resourceLabel,
  resourceSharePercent,
  resourcesOf,
  rowProgressText,
  startedAtLabel,
  timeLimitText,
  topicListMeta,
  topicListMetaText,
  topicLogs,
  topicPercent,
  topicPreviewFacts,
  type LearningViewNode
} from '../../src/shared/learningPageView'
import { INDENT_BASE, INDENT_NARROW, indentForDepth } from '../../src/shared/treeProgress'

// ===========================================================================
// 样本
// ===========================================================================

let sequence = 0

/** 造一个真实形状的树节点（只有视图计算要用的几项会被读到） */
function node(
  id: string,
  parentId: string | null,
  done = false,
  extra: Partial<LearningNode> = {}
): LearningNode {
  sequence += 1
  return {
    id,
    kind: 'node',
    ownerId: 'T',
    topicId: 'T',
    parentId,
    order: sequence,
    title: `节点 ${id}`,
    done,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...extra
  }
}

function log(
  id: string,
  date: string,
  minutes: number,
  extra: Partial<LearningLog> = {}
): LearningLog {
  return {
    id,
    kind: 'log',
    topicId: 'T',
    date,
    minutes,
    content: `日志 ${id}`,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    ...extra
  }
}

/** 本地中午的时间戳（ISO 串）：换成任何时区都落回同一天，判据不依赖跑测试的机器时区 */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString()
}

/**
 * `MASTER.md` §7.9 的实测例：
 *
 *   资料A 占比 50，内部 3/7 → 43%
 *   资料B 占比 30，内部 0/2 → 0%
 *   资料C 占比 20，内部 2/2 → 100%
 *   主题 = (50×43 + 30×0 + 20×100) ÷ 100 = 41.5 → **42%**
 *
 * （注意 `MASTER.md` 写的是 42%，因为 3/7 四舍五入就是 43：50×43 = 2150，
 *   (2150 + 2000) ÷ 100 = 41.5 → 42。逐层四舍五入的顺序见 `leafProgress` 的注释。）
 */
function sample(): LearningNode[] {
  return [
    node('A', null, false, { percent: 50 }),
    node('A1', 'A'), // 汇总章节（有子节点），自己勾了也不算
    node('A1a', 'A1', true), // 最小单元
    node('A1b', 'A1', true),
    node('A1c', 'A1', false),
    node('A2', 'A', true),
    node('A3', 'A', false),
    node('A4', 'A', false),
    node('A5', 'A', false), // A 的最小单元合计 7 个，完成 3 个
    node('B', null, false, { percent: 30 }),
    node('B1', 'B', false),
    node('B2', 'B', false),
    node('C', null, false, { percent: 20 }),
    node('C1', 'C', true),
    node('C2', 'C', true)
  ]
}

// ===========================================================================
// 照 §7.9 的文字独立写一遍（回归基准，**不许**调用被测实现）
// ===========================================================================

function referencePercent(items: LearningViewNode[]): number {
  const roots = items.filter((item) => item.parentId === null)
  if (roots.length === 0) return 0
  const share = (item: LearningViewNode): number => {
    const value = item.percent
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  }
  /** 子树里所有"没有子节点的节点"（自己数，不用 leafIds） */
  const leavesOf = (id: string): LearningViewNode[] => {
    const out: LearningViewNode[] = []
    const stack: string[] = [id]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined || seen.has(current)) continue
      seen.add(current)
      const children = items.filter((item) => item.parentId === current)
      if (children.length === 0) {
        const self = items.find((item) => item.id === current)
        if (self !== undefined) out.push(self)
        continue
      }
      for (const child of children) stack.push(child.id)
    }
    return out
  }
  let weighted = 0
  let totalShare = 0
  for (const root of roots) {
    const leaves = leavesOf(root.id)
    const percent =
      leaves.length === 0
        ? 0
        : Math.round((leaves.filter((leaf) => leaf.done).length / leaves.length) * 100)
    weighted += share(root) * percent
    totalShare += share(root)
  }
  return totalShare <= 0 ? 0 : Math.round(weighted / totalShare)
}

// ===========================================================================
// 一、学习页进度 —— 与公共实现结果一致
// ===========================================================================

describe('学习页进度：与 08 块公共实现（treeProgress.topicProgress）结果一致', () => {
  it('§7.9 的实测例：占比 50/30/20、内部 43%/0%/100% → 42%', () => {
    expect(topicPercent(sample(), 'T')).toBe(42)
  })

  it('与独立实现的加权平均逐轮一致（200 片随机森林）', () => {
    let seed = 20261011
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round += 1) {
      const items: LearningViewNode[] = []
      const rootCount = 1 + Math.floor(random() * 4)
      for (let r = 0; r < rootCount; r += 1) {
        const rootId = `r${round}-${r}`
        items.push({
          id: rootId,
          parentId: null,
          done: random() < 0.5,
          title: rootId,
          ownerId: 'T',
          topicId: 'T',
          // 随机占比：有时不填（= 等权）、有时填 0、有时填个任意正数
          percent: random() < 0.25 ? undefined : random() < 0.15 ? 0 : Math.round(random() * 100)
        })
        let parents = [rootId]
        const levels = 1 + Math.floor(random() * 4)
        for (let level = 0; level < levels; level += 1) {
          const next: string[] = []
          for (const parent of parents) {
            const childCount = Math.floor(random() * 3)
            for (let c = 0; c < childCount; c += 1) {
              const id = `${parent}-${c}`
              items.push({
                id,
                parentId: parent,
                done: random() < 0.5,
                title: id,
                ownerId: 'T',
                topicId: 'T'
              })
              next.push(id)
            }
          }
          parents = next
          if (parents.length === 0) break
        }
      }
      expect(topicPercent(items, 'T'), `第 ${round} 片森林`).toBe(referencePercent(items))
    }
  })

  it('占比自动归一化：填 5/3/2 与填 50/30/20 得到同一个数', () => {
    const scaled = sample().map((item) =>
      item.id === 'A'
        ? { ...item, percent: 5 }
        : item.id === 'B'
          ? { ...item, percent: 3 }
          : item.id === 'C'
            ? { ...item, percent: 2 }
            : item
    )
    expect(topicPercent(scaled, 'T')).toBe(topicPercent(sample(), 'T'))
  })

  it('边界：空树 / 全未完成 → 0；全完成 → 100；都不崩', () => {
    expect(topicPercent([], 'T')).toBe(0)
    expect(topicPercent([node('only', null)], 'T')).toBe(0)
    expect(topicPercent([node('only', null, true)], 'T')).toBe(100)
    const allDone = sample().map((item) => ({ ...item, done: true }))
    expect(topicPercent(allDone, 'T')).toBe(100)
    // 只有汇总节点、没有任何最小单元：不能返回 NaN
    const onlySummary = [node('S', null), node('S1', 'S')]
    expect(topicPercent(onlySummary, 'T')).toBe(0)
    // 别的主题的节点一个都不算
    expect(topicPercent(sample(), 'OTHER')).toBe(0)
  })
})

// ===========================================================================
// 二、资料行 / 章节行的两个数字
// ===========================================================================

describe('资料行显示两个数字（§7.9 / 决定 12）', () => {
  it('资料行 = `占比 50% · 已学 43%（3/7）`', () => {
    expect(rowProgressText('A', sample())).toBe('占比 50% · 已学 43%（3/7）')
  })

  it('另外两份资料的占比按归一化显示（30% / 20%）', () => {
    expect(rowProgressText('B', sample())).toBe('占比 30% · 已学 0%（0/2）')
    expect(rowProgressText('C', sample())).toBe('占比 20% · 已学 100%（2/2）')
  })

  it('占比写 5/3/2 时显示的仍是归一化后的 50% / 30% / 20%', () => {
    const scaled = sample().map((item) =>
      item.id === 'A'
        ? { ...item, percent: 5 }
        : item.id === 'B'
          ? { ...item, percent: 3 }
          : item.id === 'C'
            ? { ...item, percent: 2 }
            : item
    )
    expect(rowProgressText('A', scaled)).toContain('占比 50%')
    expect(rowProgressText('B', scaled)).toContain('占比 30%')
    expect(rowProgressText('C', scaled)).toContain('占比 20%')
  })

  it('章 / 子章行只有已学，不带占比；汇总章节自己勾了也不算', () => {
    expect(chapterProgressText(pick('A1'), sample())).toBe('已学 67%（2/3）')
    expect(rowProgressText('A1', sample())).toBe('已学 67%（2/3）')
  })

  it('找不到这个节点时返回 null（界面就不显示这一格）', () => {
    expect(rowProgressText('没有这个 id', sample())).toBeNull()
  })

  it('进度 0 / 100 的资料行也显示得对', () => {
    expect(rowProgressText('B', sample())).toBe('占比 30% · 已学 0%（0/2）')
    expect(rowProgressText('C', sample())).toBe('占比 20% · 已学 100%（2/2）')
  })
})

/** 取样本里的某个节点（找不到就抛错，免得静默造出个假节点） */
function pick(id: string): LearningNode {
  const found = sample().find((item) => item.id === id)
  if (found === undefined) throw new Error(`样本里没有 ${id}`)
  return found
}

// ===========================================================================
// 三、左栏主题行与预览信息卡
// ===========================================================================

describe('左栏主题行：名字由行自己给，另外三样在这里算', () => {
  it('进度% / 资料数 / 时长 三样都对', () => {
    const logs = [
      log('l1', '2026-10-09', 30),
      log('l2', '2026-10-10', 45, { nodeId: 'A1' }),
      log('l3', '2026-10-08', 15)
    ]
    const meta = topicListMeta('T', sample(), logs)
    expect(meta.percent).toBe(42)
    expect(meta.resourceCount).toBe(3)
    expect(meta.logCount).toBe(3)
    expect(meta.totalMinutes).toBe(90)
    expect(topicListMetaText(meta)).toBe('42% · 资料 3 · 90 分钟')
  })

  it('只算自己的：别的主题的节点与日志一条都不算', () => {
    const foreign = [node('X', null, true, { ownerId: 'OTHER', topicId: 'OTHER' })]
    const logs = [log('l1', '2026-10-09', 30, { topicId: 'OTHER' })]
    const meta = topicListMeta('T', foreign, logs)
    expect(meta).toEqual({ percent: 0, resourceCount: 0, logCount: 0, totalMinutes: 0 })
  })

  it('时长是整数分钟；坏数据（负数 / NaN）不会把总数算崩', () => {
    const logs = [log('l1', '2026-10-09', -30), log('l2', '2026-10-10', Number.NaN)]
    expect(topicListMeta('T', sample(), logs).totalMinutes).toBe(0)
  })
})

describe('预览区左侧信息卡（§6.2：说明 / 开始 / 时限 / 资料数 / 记录数）', () => {
  it('四样信息都取得到', () => {
    const logs = [log('l1', '2026-10-09', 30), log('l2', '2026-10-10', 150, { nodeId: 'A1' })]
    const facts = topicPreviewFacts(
      { id: 'T', createdAt: localNoon(2026, 9, 20), targetDays: 30 },
      sample(),
      logs
    )
    expect(facts.startedAt).toBe('2026-09-20')
    expect(facts.timeLimit).toBe('30 天')
    expect(facts.resourceCount).toBe(3)
    expect(facts.logCount).toBe(2)
    expect(facts.totalMinutes).toBe(180)
    expect(facts.recordText).toBe('2 条 · 180 分钟')
  })

  it('没说时限 / 没有时间戳时也是可读的文案，不写 Invalid Date', () => {
    const facts = topicPreviewFacts({ id: 'T' }, sample(), [])
    expect(facts.startedAt).toBe('')
    expect(facts.timeLimit).toBe('未设时限')
    expect(facts.recordText).toBe('0 条 · 0 分钟')
  })

  it('时限文字：没填 / 0 / 负数 / 乱填都是「未设时限」，正常值写成 N 天', () => {
    expect(timeLimitText(undefined)).toBe('未设时限')
    expect(timeLimitText(0)).toBe('未设时限')
    expect(timeLimitText(-7)).toBe('未设时限')
    expect(timeLimitText('abc')).toBe('未设时限')
    expect(timeLimitText('30')).toBe('30 天')
    expect(timeLimitText(30.4)).toBe('30 天')
  })

  it('开始日期：空 / 非时间戳 → 空串；正常时间戳 → 日期键', () => {
    expect(startedAtLabel(undefined)).toBe('')
    expect(startedAtLabel('')).toBe('')
    expect(startedAtLabel('不是时间')).toBe('')
    // 用"本地中午"构造：换成任何时区都能落回同一天，判据不依赖跑测试的机器在哪个时区
    expect(startedAtLabel(localNoon(2026, 9, 20))).toBe('2026-09-20')
  })

  it('记录行：负数 / NaN 收敛成 0', () => {
    expect(recordLineText(-3, -100)).toBe('0 条 · 0 分钟')
    expect(recordLineText(Number.NaN, Number.NaN)).toBe('0 条 · 0 分钟')
    expect(recordLineText(6, 180)).toBe('6 条 · 180 分钟')
  })

  it('时限天数收口：只有正整数写回，其它一律 undefined（不写 0）', () => {
    expect(clampTargetDays('30')).toBe(30)
    expect(clampTargetDays(30.6)).toBe(31)
    expect(clampTargetDays('')).toBeUndefined()
    expect(clampTargetDays('0')).toBeUndefined()
    expect(clampTargetDays(-1)).toBeUndefined()
    expect(clampTargetDays('abc')).toBeUndefined()
  })
})

// ===========================================================================
// 四、中区「资料」卡：分组 · 类型 · 占比（§6.3 / §6.5）
// ===========================================================================

describe('资料卡那一行：分组 · 类型 · 占比', () => {
  it('新数据（有分组名）：`教材 · 书 · 占比 50%`', () => {
    const nodes = sample().map((item) =>
      item.id === 'A' ? { ...item, group: '教材', resourceType: '书' } : item
    )
    expect(resourceCardMeta(nodes[0] as LearningViewNode, nodes)).toBe('教材 · 书 · 占比 50%')
  })

  it('老数据只有类型（那时它就是分组名）：不显示成「书 · 书」', () => {
    const nodes = sample().map((item) => (item.id === 'A' ? { ...item, resourceType: '书' } : item))
    expect(resourceCardMeta(nodes[0] as LearningViewNode, nodes)).toBe('书 · 占比 50%')
    expect(resourceLabel({ id: 'A', parentId: null, done: false, title: 'A', resourceType: '书' })).toBe('书')
  })

  it('分组名与类型都有但相同时只写一个', () => {
    expect(resourceLabel({ id: 'x', parentId: null, done: false, title: 'x', group: '书', resourceType: '书' })).toBe('书')
  })

  it('两样都没有：只写占比，不留空的分隔符', () => {
    expect(resourceCardMeta(pick('B'), sample())).toBe('占比 30%')
    expect(resourceLabel({ id: 'x', parentId: null, done: false, title: 'x' })).toBe('')
  })

  it('占比按归一化算（5/3/2 → 50/30/20）', () => {
    const scaled = sample().map((item) =>
      item.id === 'A'
        ? { ...item, percent: 5 }
        : item.id === 'B'
          ? { ...item, percent: 3 }
          : item.id === 'C'
            ? { ...item, percent: 2 }
            : item
    )
    expect(resourceSharePercent(scaled[0] as LearningViewNode, scaled)).toBe(50)
    expect(resourceSharePercent(scaled[9] as LearningViewNode, scaled)).toBe(30)
    expect(resourceSharePercent(scaled[12] as LearningViewNode, scaled)).toBe(20)
  })
})

// ===========================================================================
// 五、缩进规则（学习页用的是 08 块那一份，不另写）
// ===========================================================================

describe('缩进规则：第 4 层仍是 20px，第 5 层起 12px', () => {
  it('第 1–4 层每层 20px（第 4 层 = 60）', () => {
    expect(indentForDepth(0)).toBe(0)
    expect(indentForDepth(1)).toBe(INDENT_BASE)
    expect(indentForDepth(2)).toBe(INDENT_BASE * 2)
    expect(indentForDepth(3)).toBe(INDENT_BASE * 3)
    expect(indentForDepth(4)).toBe(80)
  })

  it('第 5 层起每层 12px：80 → 92 → 104', () => {
    expect(indentForDepth(5)).toBe(80 + INDENT_NARROW)
    expect(indentForDepth(6)).toBe(80 + INDENT_NARROW * 2)
    expect(indentForDepth(5) - indentForDepth(4)).toBe(INDENT_NARROW)
    expect(indentForDepth(4) - indentForDepth(3)).toBe(INDENT_BASE)
  })

  it('层数不限：深到第 30 层也照样更深，不会回退', () => {
    expect(indentForDepth(29)).toBeLessThan(indentForDepth(30))
    expect(indentForDepth(30)).toBe(80 + INDENT_NARROW * 26)
  })
})

// ===========================================================================
// 六、三步走与数据模型
// ===========================================================================

describe('三步走：进入用的是 id 比对（决定 1 / §6.6）', () => {
  it('只有"进入的就是选中的那个"才算展开', () => {
    expect(isTopicEntered('a', 'a')).toBe(true)
    expect(isTopicEntered('a', 'b')).toBe(false)
    expect(isTopicEntered(null, 'a')).toBe(false)
    expect(isTopicEntered('a', null)).toBe(false)
    expect(isTopicEntered('', '')).toBe(false)
  })
})

describe('数据模型：09 块新增的两个可选字段不影响老数据', () => {
  /**
   * `normalizeLearningRecord` 的返回值是几种记录类型的联合，
   * 这里只关心"某个键在不在 / 值是什么"，所以转成一条普通字典来读。
   */
  const normalized = (input: Record<string, unknown>): Record<string, unknown> =>
    (normalizeLearningRecord(input) ?? {}) as Record<string, unknown>

  it('节点上的分组名会留下来；没填就不写这个键', () => {
    const withGroup = normalized({
      id: 'n1',
      kind: 'node',
      ownerId: 'T',
      parentId: null,
      order: 0,
      title: '资料',
      done: false,
      percent: 50,
      group: '  教材  ',
      resourceType: '书'
    })
    expect(withGroup['group']).toBe('教材')
    const withoutGroup = normalized({
      id: 'n2',
      kind: 'node',
      ownerId: 'T',
      parentId: null,
      order: 0,
      title: '资料',
      done: false
    })
    expect('group' in withoutGroup).toBe(false)
  })

  it('主题上的时限会留下来；没填 / 0 都不写这个键', () => {
    const withDays = normalized({
      id: 't1',
      kind: 'topic',
      title: '主题',
      status: 'active',
      progress: 10,
      targetDays: 30
    })
    expect(withDays['targetDays']).toBe(30)
    const withoutDays = normalized({
      id: 't2',
      kind: 'topic',
      title: '主题',
      status: 'active',
      progress: 10
    })
    expect('targetDays' in withoutDays).toBe(false)
    const zeroDays = normalized({
      id: 't3',
      kind: 'topic',
      title: '主题',
      status: 'active',
      progress: 10,
      targetDays: 0
    })
    expect('targetDays' in zeroDays).toBe(false)
  })
})

describe('取材口径：主题树 / 资料 / 日志', () => {
  it('nodesOfTopic 只留这个主题的；resourcesOf 只留根节点', () => {
    expect(nodesOfTopic(sample(), 'T')).toHaveLength(15)
    expect(nodesOfTopic(sample(), '')).toEqual([])
    expect(resourcesOf(sample()).map((item) => item.id)).toEqual(['A', 'B', 'C'])
  })

  it('topicLogs 含挂在章节上的日志，按日期倒序（同一天保持原有先后）', () => {
    const logs = [
      log('l1', '2026-10-08', 15),
      log('l2', '2026-10-10', 30, { nodeId: 'A1' }),
      log('l3', '2026-10-09', 45),
      log('l4', '2026-10-10', 50, { topicId: 'OTHER' })
    ]
    expect(topicLogs(logs, 'T').map((item) => item.id)).toEqual(['l2', 'l3', 'l1'])
    expect(topicLogs(logs, '')).toEqual([])
  })
})
