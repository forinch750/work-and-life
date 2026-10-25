/**
 * 第 01 块测试：七个模块的新字段（v2）
 *
 * 两条必须一起成立的性质：
 *   ① **就位** —— 字段真的存在、能被 normalizeXxx 读出来、语义正确
 *   ② **可选** —— 旧数据（v1，没有这些字段）读进来不报错，且取到安全默认值
 *
 * ② 比 ① 更容易出事故：字段一旦写成必填，v1 文件会在启动自检时就报错。
 * 所以每个模块都配一条"只有 v1 字段"的用例。
 */
import { describe, expect, it } from 'vitest'
import {
  isTimeOfDay,
  isValidTimeRange,
  minutesOfDay,
  normalizePlanTask,
  normalizeTimeRange,
  timeLabel,
  timeRangeError
} from '../../src/shared/plan'
import {
  chapterProgress,
  normalizeReadingRecord,
  type ReadingNode
} from '../../src/shared/reading'
import { normalizeMemoRecord, filterByTag } from '../../src/shared/memo'
import {
  HISTORY_KEEP_LIMIT,
  historyFromOutcome,
  historyOverflowIds,
  historiesOf,
  normalizeReviewCard,
  normalizeReviewHistory,
  normalizeReviewRecord,
  applyGrade,
  dueQueue
} from '../../src/shared/review'
import {
  DEFAULT_HOTKEYS,
  DEFAULT_PREFERENCES,
  comboConflicts,
  normalizeCombo,
  normalizePreferences,
  readPreferences,
  resolveHotkeys,
  hotkeyOverrides,
  isValidCombo
} from '../../src/shared/preferences'
import { isNode, normalizeLearningRecord, shareOf } from '../../src/shared/learning'
import { MODULE_FORMAT_VERSIONS } from '../../src/main/data/format'
import { DATA_MODULES } from '../../src/shared/modules'

// ---------------------------------------------------------------------------

describe('learning：resource 的"占比"与 node 的树字段', () => {
  it('resource 能带 percent（占比）', () => {
    const parsed = normalizeLearningRecord({
      id: 'r1',
      kind: 'resource',
      topicId: 't1',
      name: '资料',
      type: '书',
      progress: '第 3/10 章',
      percent: 50
    })
    expect(parsed?.kind).toBe('resource')
    expect(parsed && 'percent' in parsed ? parsed.percent : undefined).toBe(50)
  })

  it('node 的六个树字段都读得出来', () => {
    const parsed = normalizeLearningRecord({
      id: 'n1',
      kind: 'node',
      ownerId: 't1',
      topicId: 't1',
      parentId: 'r1',
      order: 3,
      title: ' 1.1 信息就是位 ',
      done: true,
      contentFormat: 'rich'
    })
    if (!parsed || !isNode(parsed)) throw new Error('应当识别为 node')
    expect(parsed.ownerId).toBe('t1')
    expect(parsed.parentId).toBe('r1')
    expect(parsed.order).toBe(3)
    expect(parsed.title).toBe('1.1 信息就是位')
    expect(parsed.done).toBe(true)
    expect(parsed.contentFormat).toBe('rich')
  })

  it('node 缺 ownerId 时用 topicId 兜底', () => {
    const parsed = normalizeLearningRecord({ id: 'n1', kind: 'node', topicId: 't9', title: 'x' })
    if (!parsed || !isNode(parsed)) throw new Error('应当识别为 node')
    expect(parsed.ownerId).toBe('t9')
  })

  it('node 的默认值：parentId=null / order=0 / done=false / 无 contentFormat', () => {
    const parsed = normalizeLearningRecord({ id: 'n1', kind: 'node', ownerId: 't1', title: 'x' })
    if (!parsed || !isNode(parsed)) throw new Error('应当识别为 node')
    expect(parsed.parentId).toBeNull()
    expect(parsed.order).toBe(0)
    expect(parsed.done).toBe(false)
    expect(parsed.contentFormat).toBeUndefined()
  })

  it('自己当自己的父级是无意义的坏数据 → 收敛成 null', () => {
    const parsed = normalizeLearningRecord({
      id: 'n1',
      kind: 'node',
      ownerId: 't1',
      parentId: 'n1',
      title: 'x'
    })
    if (!parsed || !isNode(parsed)) throw new Error('应当识别为 node')
    expect(parsed.parentId).toBeNull()
  })

  it('占比缺省按 1 计（没设占比的资料之间等权）', () => {
    expect(shareOf({ percent: undefined })).toBe(1)
    expect(shareOf({ percent: 0 })).toBe(1)
    expect(shareOf({ percent: 50 })).toBe(50)
    expect(shareOf({ percent: 2.5 })).toBe(2.5)
  })
})

// ---------------------------------------------------------------------------

describe('reading：书 → 章 → 子章的树节点', () => {
  it('node 记录读得出来，ownerId = 书 id', () => {
    const parsed = normalizeReadingRecord({
      id: 'n1',
      kind: 'node',
      ownerId: 'b1',
      parentId: null,
      order: 1,
      title: '第 1 章',
      done: true
    })
    expect(parsed?.kind).toBe('node')
    expect((parsed as ReadingNode).ownerId).toBe('b1')
    expect((parsed as ReadingNode).done).toBe(true)
  })

  it('node 缺 ownerId 时用 bookId 兜底', () => {
    const parsed = normalizeReadingRecord({ id: 'n1', kind: 'node', bookId: 'b7', title: 'x' })
    expect((parsed as ReadingNode).ownerId).toBe('b7')
  })

  it('书的进度改为按章节算：读完的章 / 总章数（最小单元才算，汇总节点不进分母）', () => {
    const nodes: ReadingNode[] = [
      { id: 'a', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 0, title: '1', done: true },
      { id: 'b', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 1, title: '2', done: false },
      { id: 'c', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: 'b', order: 0, title: '2.1', done: true }
    ]
    // 第 02 块起口径与 MASTER §7.9 对齐：**最小单元 = 没有子节点的节点**。
    // 上面这棵书里 a、c 是最小单元（a 勾了、c 勾了），b 有子节点只做汇总，不进分母。
    expect(chapterProgress(nodes)).toEqual({ done: 2, total: 2, percent: 100 })
    expect(chapterProgress([])).toEqual({ done: 0, total: 0, percent: 0 })

    // 全部是顶层章（没有子节点）时，就是"读完的章 / 总章数"
    const flat: ReadingNode[] = [
      { id: '1', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 0, title: '第 1 章', done: true },
      { id: '2', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 1, title: '第 2 章', done: false },
      { id: '3', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 2, title: '第 3 章', done: true },
      { id: '4', createdAt: '', updatedAt: '', kind: 'node', ownerId: 'b1', parentId: null, order: 3, title: '第 4 章', done: false }
    ]
    expect(chapterProgress(flat)).toEqual({ done: 2, total: 4, percent: 50 })
  })

  it('旧书（没有 kind:node）读进来照旧', () => {
    const parsed = normalizeReadingRecord({
      id: 'b1',
      kind: 'book',
      title: '深入理解计算机系统',
      author: 'Randal',
      format: 'paper',
      status: 'reading',
      totalPages: 320,
      currentPage: 128,
      review: '旧总评'
    })
    expect(parsed?.kind).toBe('book')
    expect(parsed && 'contentFormat' in parsed ? parsed.contentFormat : undefined).toBeUndefined()
  })

  it('书的总评可以带富文本标记', () => {
    const parsed = normalizeReadingRecord({
      id: 'b1',
      kind: 'book',
      title: '书',
      review: '<p>总评</p>',
      contentFormat: 'rich'
    })
    expect(parsed && 'contentFormat' in parsed ? parsed.contentFormat : undefined).toBe('rich')
  })
})

// ---------------------------------------------------------------------------

describe('memo：tags 与 contentFormat', () => {
  it('旧备忘（只有 text/pinned）读进来不报错，新字段取安全默认值', () => {
    const parsed = normalizeMemoRecord({
      id: 'm1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      text: '旧备忘',
      pinned: true
    })
    expect(parsed?.text).toBe('旧备忘')
    expect(parsed?.pinned).toBe(true)
    // 缺省即"没有标签"、"纯文本"，**不补写字段**
    expect(parsed?.tags).toBeUndefined()
    expect(parsed?.contentFormat).toBeUndefined()
  })

  it('tags 去空去重、保持原顺序', () => {
    const parsed = normalizeMemoRecord({
      id: 'm1',
      text: 'x',
      tags: [' 工作 ', '', '工作', '生活', 42, null]
    })
    expect(parsed?.tags).toEqual(['工作', '生活'])
  })

  it('空标签数组不写出 tags 字段', () => {
    expect(normalizeMemoRecord({ id: 'm1', text: 'x', tags: [] })?.tags).toBeUndefined()
    expect(normalizeMemoRecord({ id: 'm1', text: 'x', tags: 'oops' })?.tags).toBeUndefined()
  })

  it('富文本备忘记 contentFormat', () => {
    expect(normalizeMemoRecord({ id: 'm1', text: '<p>x</p>', contentFormat: 'rich' })?.contentFormat).toBe('rich')
  })

  it('按标签筛选（空标签视为不筛）', () => {
    const memos = [
      normalizeMemoRecord({ id: 'a', text: 'a', tags: ['工作'] })!,
      normalizeMemoRecord({ id: 'b', text: 'b', tags: ['生活'] })!,
      normalizeMemoRecord({ id: 'c', text: 'c' })!
    ]
    expect(filterByTag(memos, null).map((memo) => memo.id)).toEqual(['a', 'b', 'c'])
    expect(filterByTag(memos, '工作').map((memo) => memo.id)).toEqual(['a'])
    expect(filterByTag(memos, '不存在')).toEqual([])
  })

  it('缺 id 返回 null', () => {
    expect(normalizeMemoRecord({ text: 'x' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('plan：startTime / endTime 与富文本 note', () => {
  it('旧任务（只有 timeSlot）读进来不报错，两个时间字段都不出现', () => {
    const task = normalizePlanTask({
      id: 'p1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: '晨会',
      date: '2026-02-01',
      timeSlot: 'morning',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })
    expect(task.startTime).toBeUndefined()
    expect(task.endTime).toBeUndefined()
    expect(task.noteFormat).toBeUndefined()
    expect(task.timeSlot).toBe('morning')
  })

  it('两个时间字段能读出来，且与 timeSlot 共存不覆盖', () => {
    const task = normalizePlanTask({
      id: 'p1',
      title: '晨会',
      date: '2026-02-01',
      timeSlot: 'morning',
      startTime: '09:00',
      endTime: '10:30'
    })
    expect(task.startTime).toBe('09:00')
    expect(task.endTime).toBe('10:30')
    expect(task.timeSlot).toBe('morning')
  })

  it('只填一个也可以（只记开始 / 到几点为止）', () => {
    expect(normalizePlanTask({ id: 'p', title: 'x', startTime: '09:00' }).startTime).toBe('09:00')
    expect(normalizePlanTask({ id: 'p', title: 'x', endTime: '10:00' }).endTime).toBe('10:00')
  })

  it('endTime 必须晚于 startTime，否则被拒绝写入', () => {
    expect(isValidTimeRange('10:00', '09:00')).toBe(false)
    expect(isValidTimeRange('10:00', '10:00')).toBe(false)
    expect(isValidTimeRange('10:00', '11:00')).toBe(true)
    expect(isValidTimeRange('10:00', undefined)).toBe(true)
    // 矛盾区间落库时只保留 startTime
    expect(normalizeTimeRange('10:00', '09:00')).toEqual({ startTime: '10:00' })
    expect(normalizeTimeRange('10:00', '11:00')).toEqual({ startTime: '10:00', endTime: '11:00' })
  })

  it('非法格式被丢掉，不写进数据', () => {
    expect(normalizeTimeRange('25:00', '26:00')).toEqual({})
    expect(normalizeTimeRange('9:00', 'abc')).toEqual({})
    expect(normalizePlanTask({ id: 'p', title: 'x', startTime: '25:00' }).startTime).toBeUndefined()
  })

  it('isTimeOfDay / minutesOfDay 的边界', () => {
    expect(isTimeOfDay('00:00')).toBe(true)
    expect(isTimeOfDay('23:59')).toBe(true)
    expect(isTimeOfDay('24:00')).toBe(false)
    expect(isTimeOfDay('9:00')).toBe(false)
    expect(isTimeOfDay('09:60')).toBe(false)
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('10:30')).toBe(630)
    expect(minutesOfDay('oops')).toBeNull()
  })

  it('timeRangeError 给出可显示的原因', () => {
    expect(timeRangeError('10:00', '11:00')).toBeNull()
    expect(timeRangeError('10:00', '09:00')).toContain('晚于')
    expect(timeRangeError('9:00', undefined)).toContain('HH:mm')
  })

  it('timeLabel：有具体时间优先，否则退回时段名', () => {
    expect(timeLabel({ startTime: '10:00', endTime: '11:30', timeSlot: 'none' })).toBe('10:00–11:30')
    expect(timeLabel({ startTime: '10:00', timeSlot: 'morning' })).toBe('10:00')
    expect(timeLabel({ timeSlot: 'morning' })).toBe('上午')
    expect(timeLabel({ timeSlot: 'none' })).toBe('全天')
  })

  it('备注的富文本标记', () => {
    expect(normalizePlanTask({ id: 'p', title: 'x', note: '<p>备注</p>', noteFormat: 'rich' }).noteFormat).toBe('rich')
    expect(normalizePlanTask({ id: 'p', title: 'x', note: '纯文本' }).noteFormat).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('review：history / dueTime / 卡片归属', () => {
  it('旧卡片（没有 kind / dueTime / topicId）读进来不报错', () => {
    const card = normalizeReviewCard({
      id: 'c1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      front: '正面',
      back: '背面',
      source: '英语长难句',
      stage: 2,
      dueDate: '2026-02-14',
      reviewCount: 3,
      lastReviewedAt: '2026-02-07T00:00:00.000Z'
    })
    expect(card?.front).toBe('正面')
    expect(card?.dueTime).toBeUndefined()
    expect(card?.topicId).toBeUndefined()
    expect(card?.nodeId).toBeUndefined()
  })

  it('dueTime 能读出来，非法格式不写入', () => {
    expect(normalizeReviewCard({ id: 'c1', front: 'x', dueTime: '20:30' })?.dueTime).toBe('20:30')
    expect(normalizeReviewCard({ id: 'c1', front: 'x', dueTime: '25:00' })?.dueTime).toBeUndefined()
    expect(normalizeReviewCard({ id: 'c1', front: 'x', dueTime: 'oops' })?.dueTime).toBeUndefined()
  })

  it('卡片能归属到主题与章节（topicId / nodeId）', () => {
    const card = normalizeReviewCard({
      id: 'c1',
      front: 'x',
      topicId: 't1',
      nodeId: 'n9'
    })
    expect(card?.topicId).toBe('t1')
    expect(card?.nodeId).toBe('n9')
  })

  it('kind:history 的记录不会被当成卡片（否则到期数会凭空变大）', () => {
    const historyRecord = {
      id: 'h1',
      createdAt: '2026-02-14T00:00:00.000Z',
      updatedAt: '2026-02-14T00:00:00.000Z',
      kind: 'history',
      cardId: 'c1',
      at: '2026-02-14T09:00:00.000Z',
      grade: 'remembered',
      stageBefore: 1,
      stageAfter: 2,
      dueDateAfter: '2026-02-21'
    }
    expect(normalizeReviewCard(historyRecord)).toBeNull()

    // 混在同一个文件里时，到期队列只看得见卡片
    const records = [historyRecord, { id: 'c1', front: '正面', dueDate: '2026-02-14' }]
    const cards = records
      .map((record) => normalizeReviewCard(record))
      .filter((card): card is NonNullable<typeof card> => card !== null)
    expect(cards).toHaveLength(1)
    expect(dueQueue(cards, '2026-02-14')).toHaveLength(1)
  })

  it('history 记录本身读得出来', () => {
    const history = normalizeReviewHistory({
      id: 'h1',
      kind: 'history',
      cardId: 'c1',
      at: '2026-02-14T09:00:00.000Z',
      grade: 'fuzzy',
      stageBefore: 0,
      stageAfter: 0,
      dueDateAfter: '2026-02-17'
    })
    expect(history?.cardId).toBe('c1')
    expect(history?.grade).toBe('fuzzy')
    expect(history?.dueDateAfter).toBe('2026-02-17')
  })

  it('normalizeReviewRecord 能同时分辨两种记录', () => {
    const card = normalizeReviewRecord({ id: 'c1', front: 'x' })
    const history = normalizeReviewRecord({ id: 'h1', kind: 'history', cardId: 'c1' })
    expect(card?.kind).toBe('card')
    expect(history?.kind).toBe('history')
  })

  it('缺 id / 缺 cardId 的历史记录返回 null', () => {
    expect(normalizeReviewHistory({ kind: 'history', cardId: 'c1' })).toBeNull()
    expect(normalizeReviewHistory({ id: 'h1', kind: 'history' })).toBeNull()
    expect(normalizeReviewHistory({ id: 'h1' })).toBeNull()
  })

  it('applyGrade 的返回值能直接落成一条历史（字段一个不缺）', () => {
    const outcome = applyGrade({ stage: 1, reviewCount: 4 }, 'remembered', '2026-02-14')
    const history = historyFromOutcome('c1', outcome, '2026-02-14T09:00:00.000Z')
    expect(history.kind).toBe('history')
    expect(history.cardId).toBe('c1')
    expect(history.grade).toBe('remembered')
    expect(history.stageBefore).toBe(1)
    expect(history.stageAfter).toBe(outcome.stageAfter)
    expect(history.dueDateAfter).toBe(outcome.dueDate)
    expect(history.at).toBe('2026-02-14T09:00:00.000Z')
  })

  it('每张卡只保留最近 50 次：超出的 id 会被列出', () => {
    const history = (index: number, at: string) => ({
      id: `h${index}`,
      createdAt: '',
      updatedAt: '',
      kind: 'history' as const,
      cardId: 'c1',
      at,
      grade: 'fuzzy' as const,
      stageBefore: 0,
      stageAfter: 0,
      dueDateAfter: '2026-02-17'
    })
    // 造 52 条，时间严格递增 → 最后两条（h0 / h1）最老，应当被丢弃
    const many = Array.from({ length: 52 }, (_item, index) => {
      const day = new Date(Date.UTC(2026, 0, 1 + index))
      return history(index, `${day.toISOString().slice(0, 10)}T00:00:00.000Z`)
    })
    const overflow = historyOverflowIds(many)
    expect(overflow).toHaveLength(52 - HISTORY_KEEP_LIMIT)
    // 被丢弃的是最老的两条（at 最小的），它们都是同一天写入的，
    // 同秒并列时按 id 的字典序稳定输出
    expect([...overflow].sort()).toEqual(['h0', 'h1'])
    expect(historyOverflowIds(many.slice(0, 50))).toEqual([])
  })

  it('historiesOf 只取某张卡的历史并按时间倒序', () => {
    const base = {
      createdAt: '',
      updatedAt: '',
      kind: 'history' as const,
      grade: 'fuzzy' as const,
      stageBefore: 0,
      stageAfter: 0,
      dueDateAfter: '2026-02-17'
    }
    const list = [
      { ...base, id: 'h1', cardId: 'c1', at: '2026-02-01T00:00:00.000Z' },
      { ...base, id: 'h2', cardId: 'c1', at: '2026-02-03T00:00:00.000Z' },
      { ...base, id: 'h3', cardId: 'c2', at: '2026-02-02T00:00:00.000Z' }
    ]
    expect(historiesOf(list, 'c1').map((item) => item.id)).toEqual(['h2', 'h1'])
  })
})

// ---------------------------------------------------------------------------

describe('app：偏好里的 trashKeepDays 与快捷键绑定', () => {
  it('旧偏好（没有 hotkeys）读进来：默认值打底，且不写出 hotkeys', () => {
    const prefs = normalizePreferences({ theme: 'dark', weekStart: 7 })
    expect(prefs.theme).toBe('dark')
    expect(prefs.weekStart).toBe(7)
    expect(prefs.trashKeepDays).toBe(DEFAULT_PREFERENCES.trashKeepDays)
    expect(prefs.hotkeys).toBeUndefined()
  })

  it('完全空的输入也拿得到完整默认偏好', () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences('oops')).toEqual(DEFAULT_PREFERENCES)
  })

  it('trashKeepDays 已有：确认它在、并按范围收敛', () => {
    expect(readPreferences([{ id: 'preferences' }]).trashKeepDays).toBe(30)
    expect(normalizePreferences({ trashKeepDays: 7 }).trashKeepDays).toBe(7)
    expect(normalizePreferences({ trashKeepDays: 0 }).trashKeepDays).toBe(1)
    expect(normalizePreferences({ trashKeepDays: 'abc' }).trashKeepDays).toBe(30)
  })

  it('hotkeys 能存能读，非法值被忽略', () => {
    const prefs = normalizePreferences({ hotkeys: { save: 'ctrl+shift+s', new: '不是组合键' } })
    expect(prefs.hotkeys?.save).toBe('ctrl+shift+s')
    // 非法的那一项整条丢掉（读的时候回退默认）
    expect(prefs.hotkeys?.new).toBeUndefined()
    expect(resolveHotkeys(prefs.hotkeys).new).toBe(DEFAULT_HOTKEYS.new)
  })

  it('hotkeys 不是对象时不写出该字段', () => {
    expect(normalizePreferences({ hotkeys: 'oops' }).hotkeys).toBeUndefined()
    expect(normalizePreferences({ hotkeys: [] }).hotkeys).toBeUndefined()
  })

  it('组合键写法归一化：小写、修饰键必须已在规范顺序上', () => {
    expect(normalizeCombo('Ctrl+Shift+S')).toBe('ctrl+shift+s')
    expect(normalizeCombo('ctrl+alt+m')).toBe('ctrl+alt+m')
    // 跳过中间的修饰键是合法写法（Ctrl+Shift+S 本来就是"另存为"）
    expect(normalizeCombo('ctrl+shift+s')).toBe('ctrl+shift+s')
    expect(normalizeCombo(' escape ')).toBe('escape')
    // 乱序写法明确拒绝，不悄悄改写用户填的东西
    expect(normalizeCombo('shift+ctrl+s')).toBeNull()
    expect(normalizeCombo('alt+ctrl+s')).toBeNull()
    // 重复修饰键不能被去重成合法值而蒙混过关
    expect(normalizeCombo('ctrl+ctrl+s')).toBeNull()
    expect(normalizeCombo('ctrl+')).toBeNull()
    expect(normalizeCombo('foo+s')).toBeNull()
    expect(normalizeCombo('ctrl+shift')).toBeNull()
    expect(normalizeCombo('')).toBeNull()
    expect(normalizeCombo(42)).toBeNull()
  })

  it('isValidCombo 只认主键为单字符或几个特殊键', () => {
    expect(isValidCombo('n')).toBe(true)
    expect(isValidCombo('ctrl+s')).toBe(true)
    expect(isValidCombo('f1')).toBe(false)
    expect(isValidCombo('escape')).toBe(true)
  })

  it('resolveHotkeys 给出完整绑定表', () => {
    const bindings = resolveHotkeys({ new: 'ctrl+n' })
    expect(bindings.new).toBe('ctrl+n')
    expect(bindings.save).toBe('ctrl+s')
    expect(bindings.today).toBe('t')
    expect(Object.keys(bindings).sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort())
  })

  it('hotkeyOverrides 只留与默认不同的项（落库用）', () => {
    const bindings = { ...DEFAULT_HOTKEYS, new: 'ctrl+n' }
    expect(hotkeyOverrides(bindings)).toEqual({ new: 'ctrl+n' })
    expect(hotkeyOverrides(DEFAULT_HOTKEYS)).toEqual({})
  })

  it('冲突检查：同一个组合键被两个动作占用时都能查出来', () => {
    const bindings = { ...DEFAULT_HOTKEYS, new: 't' }
    expect(comboConflicts(bindings, 't').sort()).toEqual(['new', 'today'])
    expect(comboConflicts(bindings, 'ctrl+s')).toEqual(['save'])
    expect(comboConflicts(bindings, '不是组合键')).toEqual([])
  })

  it('N / T 的默认绑定与已定语义一致', () => {
    expect(DEFAULT_HOTKEYS.new).toBe('n')
    expect(DEFAULT_HOTKEYS.today).toBe('t')
    expect(DEFAULT_HOTKEYS.save).toBe('ctrl+s')
  })
})

// ---------------------------------------------------------------------------

describe('七个模块的格式版本', () => {
  it('六个数据模块各自都升到 2', () => {
    for (const module of DATA_MODULES) {
      expect(MODULE_FORMAT_VERSIONS[module]).toBe(2)
    }
    expect(DATA_MODULES).toHaveLength(6)
  })
})
