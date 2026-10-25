/**
 * 阶段 5 测试：学习模块模型（PRD §5.3 / §10.6 F1–F5）
 */
import { describe, expect, it } from 'vitest'
import {
  clampMinutes,
  clampProgress,
  isTopicStatus,
  logToCard,
  normalizeLearningRecord,
  progressFromResources,
  sortLogs,
  studyMarks,
  summarizeTopics,
  type LearningLog,
  type LearningResource,
  type LearningTopic
} from '../../src/shared/learning'

function topic(overrides: Partial<LearningTopic> = {}): LearningTopic {
  return {
    id: 't1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'topic',
    title: '英语长难句',
    status: 'active',
    progress: 45,
    ...overrides
  }
}

function resource(overrides: Partial<LearningResource> = {}): LearningResource {
  return {
    id: 'r1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'resource',
    topicId: 't1',
    name: '《语法俱乐部》',
    type: '书',
    progress: '第 3/10 章',
    ...overrides
  }
}

function log(overrides: Partial<LearningLog> = {}): LearningLog {
  return {
    id: 'l1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'log',
    topicId: 't1',
    date: '2026-02-14',
    minutes: 45,
    content: '读完第 3 章',
    ...overrides
  }
}

describe('clampProgress', () => {
  it('夹到 0–100 的整数', () => {
    expect(clampProgress(45)).toBe(45)
    expect(clampProgress(-10)).toBe(0)
    expect(clampProgress(180)).toBe(100)
    expect(clampProgress(45.6)).toBe(46)
  })

  it('接受可解析的字符串', () => {
    expect(clampProgress('30')).toBe(30)
    expect(clampProgress(' 70 ')).toBe(70)
  })

  it('无法解析时回退到 0', () => {
    expect(clampProgress('abc')).toBe(0)
    expect(clampProgress(null)).toBe(0)
    expect(clampProgress(Number.NaN)).toBe(0)
  })
})

describe('clampMinutes', () => {
  it('夹到 0–1440', () => {
    expect(clampMinutes(45)).toBe(45)
    expect(clampMinutes(-5)).toBe(0)
    expect(clampMinutes(5000)).toBe(1440)
  })

  it('无法解析时回退到 0', () => {
    expect(clampMinutes('abc')).toBe(0)
    expect(clampMinutes(undefined)).toBe(0)
  })
})

describe('isTopicStatus', () => {
  it('只认三种状态', () => {
    expect(isTopicStatus('active')).toBe(true)
    expect(isTopicStatus('done')).toBe(true)
    expect(isTopicStatus('archived')).toBe(true)
    expect(isTopicStatus('进行中')).toBe(false)
    expect(isTopicStatus(null)).toBe(false)
  })
})

describe('normalizeLearningRecord', () => {
  it('识别 topic 并补齐默认值', () => {
    const result = normalizeLearningRecord({ id: 'x', kind: 'topic', title: ' 数据结构 ' })
    expect(result?.kind).toBe('topic')
    if (result?.kind === 'topic') {
      expect(result.title).toBe('数据结构')
      expect(result.status).toBe('active')
      expect(result.progress).toBe(0)
    }
  })

  it('识别 resource，percent 为 0 时不写入该字段', () => {
    const result = normalizeLearningRecord({
      id: 'x',
      kind: 'resource',
      topicId: 't1',
      name: '某公开课',
      type: '视频'
    })
    expect(result?.kind).toBe('resource')
    if (result?.kind === 'resource') {
      expect(result.percent).toBeUndefined()
      expect(result.type).toBe('视频')
    }
  })

  it('识别 log 并夹住时长', () => {
    const result = normalizeLearningRecord({
      id: 'x',
      kind: 'log',
      topicId: 't1',
      date: '2026-02-14',
      minutes: 9999,
      content: ' 学了很久 '
    })
    if (result?.kind === 'log') {
      expect(result.minutes).toBe(1440)
      expect(result.content).toBe('学了很久')
    } else {
      throw new Error('应当识别为 log')
    }
  })

  it('未知 kind 返回 null', () => {
    expect(normalizeLearningRecord({ id: 'x', kind: '未知' })).toBeNull()
    expect(normalizeLearningRecord({ id: 'x' })).toBeNull()
  })

  it('缺少 id 返回 null', () => {
    expect(normalizeLearningRecord({ kind: 'topic', title: '无 id' })).toBeNull()
  })
})

describe('progressFromResources（按资料推进）', () => {
  it('没有资料时为 0', () => {
    expect(progressFromResources([])).toBe(0)
  })

  it('取最高完成度，而不是平均值', () => {
    const result = progressFromResources([
      resource({ id: 'a', percent: 80 }),
      resource({ id: 'b', percent: 10 }),
      resource({ id: 'c' })
    ])
    expect(result).toBe(80)
  })

  it('资料都没写 percent 时为 0', () => {
    expect(progressFromResources([resource({ id: 'a' }), resource({ id: 'b' })])).toBe(0)
  })
})

describe('summarizeTopics（学习页列表）', () => {
  it('统计资料数、日志数与总时长', () => {
    const summaries = summarizeTopics(
      [topic({ id: 't1' }), topic({ id: 't2', title: '数据结构' })],
      [resource({ id: 'r1', topicId: 't1' }), resource({ id: 'r2', topicId: 't1' })],
      [
        log({ id: 'l1', topicId: 't1', minutes: 45 }),
        log({ id: 'l2', topicId: 't1', minutes: 30, date: '2026-02-12' }),
        log({ id: 'l3', topicId: 't2', minutes: 20 })
      ]
    )
    const first = summaries.find((item) => item.topic.id === 't1')
    expect(first?.resourceCount).toBe(2)
    expect(first?.logCount).toBe(2)
    expect(first?.totalMinutes).toBe(75)
    expect(first?.lastLogDate).toBe('2026-02-14')

    const second = summaries.find((item) => item.topic.id === 't2')
    expect(second?.resourceCount).toBe(0)
    expect(second?.totalMinutes).toBe(20)
  })

  it('没有日志时 lastLogDate 为 null', () => {
    const summaries = summarizeTopics([topic({ id: 't9' })], [], [])
    expect(summaries[0]?.lastLogDate).toBeNull()
    expect(summaries[0]?.totalMinutes).toBe(0)
  })

  it('不会把别的主题的日志算进来', () => {
    const summaries = summarizeTopics(
      [topic({ id: 't1' })],
      [],
      [log({ id: 'l1', topicId: 't2' })]
    )
    expect(summaries[0]?.logCount).toBe(0)
  })
})

describe('sortLogs', () => {
  it('按日期倒序，同日按创建时间倒序', () => {
    const sorted = sortLogs([
      log({ id: 'a', date: '2026-02-10' }),
      log({ id: 'b', date: '2026-02-14', createdAt: '2026-02-14T08:00:00.000Z' }),
      log({ id: 'c', date: '2026-02-14', createdAt: '2026-02-14T20:00:00.000Z' })
    ])
    expect(sorted.map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('studyMarks（进度条上的每日刻度）', () => {
  it('同一天多次学习会累加分钟数', () => {
    const marks = studyMarks([
      log({ id: 'a', date: '2026-02-14', minutes: 30 }),
      log({ id: 'b', date: '2026-02-14', minutes: 15 }),
      log({ id: 'c', date: '2026-02-12', minutes: 60 })
    ])
    expect(marks).toEqual([
      { date: '2026-02-12', minutes: 60 },
      { date: '2026-02-14', minutes: 45 }
    ])
  })

  it('没有日志时为空数组', () => {
    expect(studyMarks([])).toEqual([])
  })
})

describe('logToCard（F4：学习日志 → 复习卡）', () => {
  it('正面取主题 + 日志内容，背面记录时长信息', () => {
    const result = logToCard(log({ content: '读完第 3 章', minutes: 45, date: '2026-02-14' }), '英语长难句')
    expect(result.front).toContain('英语长难句')
    expect(result.front).toContain('读完第 3 章')
    expect(result.back).toContain('45')
    expect(result.back).toContain('2026-02-14')
    expect(result.source).toBe('英语长难句')
  })
})
