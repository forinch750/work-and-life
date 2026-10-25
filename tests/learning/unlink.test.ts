/**
 * 删除前解除关联的单测（第二轮 BUG-007）
 *
 * 重点：漏掉任何一类引用都会在界面上留下悬空引用
 * （任务指向一个已经不存在的主题、书下面挂着已删章节），很难靠手点发现。
 * 同时要守住"关联数据不自动删除"这条规则——学习日志与阅读记录必须留下。
 */
import { describe, expect, it } from 'vitest'
import { unlinkBook, unlinkLearningTopic, unlinkTreeNode } from '../../src/shared/unlink'

function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra }
}

describe('unlinkLearningTopic 删除学习主题', () => {
  const learning = [
    rec('t1', { kind: 'topic', title: '英语' }),
    rec('r1', { kind: 'resource', topicId: 't1', name: '语法俱乐部' }),
    rec('r2', { kind: 'resource', topicId: 't1', name: '词根词缀' }),
    rec('r3', { kind: 'resource', topicId: 't2', name: '别的主题的资料' }),
    rec('l1', { kind: 'log', topicId: 't1', content: '读了第三章', minutes: 30 }),
    rec('n1', { kind: 'node', ownerId: 't1', title: '第一章' })
  ]

  it('主题下的资料与章节一并软删除', () => {
    const result = unlinkLearningTopic('t1', learning, [])
    const ids = result.patches.map((p) => p.id).sort()
    expect(ids).toEqual(['n1', 'r1', 'r2'])
    for (const patch of result.patches) {
      expect(patch.module).toBe('learning')
      expect(typeof patch.patch['deletedAt']).toBe('string')
    }
  })

  it('学习日志必须保留（关联数据不自动删除）', () => {
    const result = unlinkLearningTopic('t1', learning, [])
    expect(result.patches.some((p) => p.id === 'l1')).toBe(false)
    expect(result.summary).toContain('学习日志会保留')
  })

  it('别的主题下的资料不受影响', () => {
    const result = unlinkLearningTopic('t1', learning, [])
    expect(result.patches.some((p) => p.id === 'r3')).toBe(false)
  })

  it('计划任务上的 projectId 指向该主题时被清空', () => {
    const plan = [
      rec('task1', { title: '背单词', projectId: 't1' }),
      rec('task2', { title: '别的任务', projectId: 't2' }),
      rec('task3', { title: '无所属任务' })
    ]
    const result = unlinkLearningTopic('t1', learning, plan)
    const planPatches = result.patches.filter((p) => p.module === 'plan')
    expect(planPatches).toEqual([{ module: 'plan', id: 'task1', patch: { projectId: '' } }])
  })

  it('任务本身不被删除（只解除归属）', () => {
    const plan = [rec('task1', { projectId: 't1' })]
    const result = unlinkLearningTopic('t1', learning, plan)
    for (const patch of result.patches.filter((p) => p.module === 'plan')) {
      expect(patch.patch['deletedAt']).toBeUndefined()
    }
  })

  it('已经删除的记录不再重复处理（幂等）', () => {
    const withDeleted = [
      ...learning,
      rec('r9', { kind: 'resource', topicId: 't1', deletedAt: '2026-10-09T00:00:00.000Z' })
    ]
    const result = unlinkLearningTopic('t1', withDeleted, [])
    expect(result.patches.some((p) => p.id === 'r9')).toBe(false)
  })

  it('说明文字如实反映影响范围', () => {
    const plan = [rec('task1', { projectId: 't1' })]
    const result = unlinkLearningTopic('t1', learning, plan)
    expect(result.summary).toContain('3 项资料/章节')
    expect(result.summary).toContain('1 个任务')
  })

  it('没有任何关联时也不报错', () => {
    const result = unlinkLearningTopic('不存在', learning, [])
    expect(result.patches).toEqual([])
    expect(result.summary).toContain('0 项')
  })
})

describe('unlinkBook 删除书', () => {
  const reading = [
    rec('b1', { kind: 'book', title: '深入理解计算机系统' }),
    rec('p1', { kind: 'progress', bookId: 'b1', date: '2026-10-01' }),
    rec('e1', { kind: 'excerpt', bookId: 'b1', content: '原文' }),
    rec('n1', { kind: 'node', ownerId: 'b1', title: '第三章' }),
    rec('n2', { kind: 'node', ownerId: 'b1', title: '3.1 小节' })
  ]

  it('书下的章节被软删除', () => {
    const result = unlinkBook('b1', reading)
    expect(result.patches.map((p) => p.id).sort()).toEqual(['n1', 'n2'])
  })

  it('阅读记录与摘录必须保留（那是阅读痕迹）', () => {
    const result = unlinkBook('b1', reading)
    expect(result.patches.some((p) => p.id === 'p1')).toBe(false)
    expect(result.patches.some((p) => p.id === 'e1')).toBe(false)
    expect(result.summary).toContain('阅读记录与摘录会保留')
  })

  it('没有章节时说明文字不提章节', () => {
    const result = unlinkBook('b1', [rec('b1', { kind: 'book' })])
    expect(result.patches).toEqual([])
    expect(result.summary).not.toContain('章节')
  })
})

describe('unlinkTreeNode 删除树节点', () => {
  it('连同整棵子树一起软删除', () => {
    const result = unlinkTreeNode('ch1', ['s11', 'i111'], 'learning')
    expect(result.patches.map((p) => p.id).sort()).toEqual(['ch1', 'i111', 's11'])
    expect(result.summary).toContain('2 个子章节')
  })

  it('叶子节点只删自己', () => {
    const result = unlinkTreeNode('leaf', [], 'reading')
    expect(result.patches).toHaveLength(1)
    expect(result.patches[0]?.module).toBe('reading')
    expect(result.summary).toContain('没有子章节')
  })

  it('同一批补丁共用同一个删除时刻（便于回收站按批恢复）', () => {
    const result = unlinkTreeNode('ch1', ['s11', 'i111'], 'learning')
    const stamps = new Set(result.patches.map((p) => p.patch['deletedAt']))
    expect(stamps.size).toBe(1)
  })
})
