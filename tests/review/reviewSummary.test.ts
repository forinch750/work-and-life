/**
 * 第 05 块测试：复习汇总横条的纯逻辑（已定决定 19 的防漏出口）
 *
 * 去掉全局到期队列以后，"今天总共欠多少张、欠在哪些主题上"只剩
 * ① 导航角标 ② 复习页顶部汇总横条 两个地方能看见。
 * 这里钉住横条那两个读数（总数与各主题分布）的算法，
 * 免得界面上的数字与到期队列悄悄漂开。
 */
import { describe, expect, it } from 'vitest'
import {
  dueQueue,
  summaryDistributionText,
  summaryTotalText,
  topicDistribution,
  type ReviewCard
} from '../../src/shared/review'

const TODAY = '2026-02-14'

let seq = 0
function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  seq += 1
  return {
    id: overrides.id ?? `s${seq}`,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    front: '问题',
    back: '答案',
    source: overrides.source ?? '而对方',
    stage: 0,
    dueDate: overrides.dueDate ?? TODAY,
    reviewCount: 0,
    lastReviewedAt: null
  }
}

describe('topicDistribution：今天到期的卡按主题分布', () => {
  it('按主题聚合，张数多的在前', () => {
    const cards = [
      card({ source: '而对方' }),
      card({ source: '而对方' }),
      card({ source: '而对方' }),
      card({ source: '热力学' }),
      card({ source: '热力学' }),
      card({ source: '英语长难句' })
    ]
    expect(topicDistribution(cards, TODAY)).toEqual([
      { topic: '而对方', count: 3 },
      { topic: '热力学', count: 2 },
      { topic: '英语长难句', count: 1 }
    ])
  })

  it('只算**今天到期**的卡：没到期的不进分布', () => {
    const cards = [
      card({ source: '而对方', dueDate: TODAY }),
      card({ source: '而对方', dueDate: '2026-02-10' }), // 已逾期，算到期
      card({ source: '热力学', dueDate: '2026-03-01' }) // 未到期
    ]
    const buckets = topicDistribution(cards, TODAY)
    expect(buckets).toEqual([{ topic: '而对方', count: 2 }])
    // 总数必须与到期队列一致（两处各写一份就会漂）
    expect(buckets.reduce((sum, item) => sum + item.count, 0)).toBe(dueQueue(cards, TODAY).length)
  })

  it('张数相同时按主题名排序（顺序稳定，不随数据顺序跳）', () => {
    const a = topicDistribution(
      [card({ source: '乙' }), card({ source: '甲' })],
      TODAY
    ).map((item) => item.topic)
    const b = topicDistribution(
      [card({ source: '甲' }), card({ source: '乙' })],
      TODAY
    ).map((item) => item.topic)
    expect(a).toEqual(b)
  })

  it('没有到期卡时是空数组', () => {
    expect(topicDistribution([], TODAY)).toEqual([])
    expect(topicDistribution([card({ dueDate: '2026-03-01' })], TODAY)).toEqual([])
  })
})

describe('汇总横条的文案', () => {
  it('总数句写明"全部主题合计"', () => {
    expect(summaryTotalText(12)).toBe('今天到期 12 张（全部主题合计）')
    expect(summaryTotalText(0)).toBe('今天到期 0 张（全部主题合计）')
  })

  it('分布句用 · 连接，每项带主题名与张数', () => {
    expect(
      summaryDistributionText([
        { topic: '而对方', count: 3 },
        { topic: '热力学', count: 2 }
      ])
    ).toBe('而对方 3 张 · 热力学 2 张')
    expect(summaryDistributionText([])).toBe('')
  })

  it('被隐藏的主题**照样出现**，只多一个「（已隐藏）」标注（修改 2 轮 · 防漏）', () => {
    // 关键：数字还是 2，不能因为隐藏就变成"没有到期卡"
    expect(
      summaryDistributionText([
        { topic: '而对方', count: 3 },
        { topic: '热力学', count: 2, hidden: true },
        { topic: '英语', count: 1 }
      ])
    ).toBe('而对方 3 张 · 热力学 2 张（已隐藏） · 英语 1 张')
    // 全都没隐藏时一个字都不变（老行为原样）
    expect(summaryDistributionText([{ topic: '甲', count: 1, hidden: false }])).toBe('甲 1 张')
  })
})
