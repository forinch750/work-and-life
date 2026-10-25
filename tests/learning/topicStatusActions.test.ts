/**
 * 修改 4 轮测试：学习主题的状态按钮矩阵（可逆）
 *
 * ## 为什么要有这一组
 *
 * 用户原话：「无法把已归档的转为未归档（学习）」、
 * 「**标记完成不能取消**。**归档和标记完成不能同时出现**」。
 *
 * 数据层（`shared/learning.ts` 的 `TopicStatus`）一直是三态，坏的是界面：
 * 两个按钮都**无条件显示**、目标状态**写死在 onClick 里**，于是状态只能单向前进，
 * 而且已归档的主题上还挂着「标记完成」「归档」两个按钮。
 *
 * ## 这一组钉住什么
 *
 *   1. 三个状态各自的按钮矩阵（`active` / `done` / `archived` → 出现哪几个 testid）
 *   2. `done → active`、`archived → active` **都能回**
 *   3. **`archived` 时「标记完成 / 标记未完成」不出现**（防回潮：这一条最容易在
 *      以后有人"顺手把按钮加回去"时失守）
 *   4. 目标状态是**算出来的**（每个动作自带 `target`），不是页面里写死的字符串
 *
 * vitest 是 `environment: 'node'`（没有 jsdom、也不许引 jsdom），
 * 所以这里测的是"矩阵算得对不对"，DOM 上的出现/消失交给端到端
 * `src\main\verify\phase8.ts` 的 `P8-Z1` / `P8-Z2`。
 */
import { describe, expect, it } from 'vitest'
import type { TopicStatus } from '../../src/shared/learning'
import {
  TOPIC_STATUS_ACTION_LABELS,
  topicStatusActions,
  type TopicStatusActionId
} from '../../src/shared/learningPageView'

/** 某状态下会出现哪些 testid（顺序即界面顺序） */
function idsOf(status: TopicStatus): TopicStatusActionId[] {
  return topicStatusActions(status).map((action) => action.id)
}

const ALL_STATUS: TopicStatus[] = ['active', 'done', 'archived']

describe('学习主题：三个状态各自的按钮矩阵（修改 4 §6.1）', () => {
  it('active（进行中）= 标记完成 + 归档', () => {
    expect(idsOf('active')).toEqual(['learning-mark-done', 'learning-archive'])
    expect(topicStatusActions('active').map((action) => action.target)).toEqual([
      'done',
      'archived'
    ])
  })

  it('done（已完成）= 标记未完成 + 归档 —— 标记完成可以取消了', () => {
    expect(idsOf('done')).toEqual(['learning-mark-undone', 'learning-archive'])
    expect(topicStatusActions('done').map((action) => action.target)).toEqual([
      'active',
      'archived'
    ])
  })

  it('archived（已归档）= 只有取消归档 —— 归档与标记完成不再共存', () => {
    expect(idsOf('archived')).toEqual(['learning-unarchive'])
    expect(topicStatusActions('archived').map((action) => action.target)).toEqual(['active'])
  })

  it('archived 时「标记完成 / 标记未完成」都不出现（防回潮）', () => {
    const ids = idsOf('archived')
    expect(ids).not.toContain('learning-mark-done')
    expect(ids).not.toContain('learning-mark-undone')
  })

  it('只有 active / done 时才出现「归档」（ARCHIVE 只在未归档状态）', () => {
    expect(idsOf('active')).toContain('learning-archive')
    expect(idsOf('done')).toContain('learning-archive')
    expect(idsOf('archived')).not.toContain('learning-archive')
  })

  it('沿用既有 testid：active 的「标记完成」仍是 learning-mark-done、归档仍是 learning-archive', () => {
    // 既有端到端（phase5 的 P5-F5 等）还在点这两个 id，条件显示之后必须仍然有效
    expect(idsOf('active')).toContain('learning-mark-done')
    expect(idsOf('active')).toContain('learning-archive')
    expect(idsOf('done')).toContain('learning-archive')
  })

  it('一次只出现一组互斥项：标记完成 / 标记未完成 永不同时出现', () => {
    for (const status of ALL_STATUS) {
      const ids = idsOf(status)
      const both = ids.includes('learning-mark-done') && ids.includes('learning-mark-undone')
      expect(both, `状态 ${status} 同时出现了两个打勾项`).toBe(false)
      // 归档 / 取消归档同理（同一件事的两种说法）
      const bothArchive = ids.includes('learning-archive') && ids.includes('learning-unarchive')
      expect(bothArchive, `状态 ${status} 同时出现了归档与取消归档`).toBe(false)
    }
  })

  it('每个状态的动作 id 不重复（界面不会画出两个同名按钮）', () => {
    for (const status of ALL_STATUS) {
      const ids = idsOf(status)
      expect(new Set(ids).size, `状态 ${status} 的 testid 有重复：${ids.join(',')}`).toBe(ids.length)
    }
  })

  it('文案与 target 都来自唯一一份定义（页面不另写一套字符串）', () => {
    expect(TOPIC_STATUS_ACTION_LABELS).toEqual({
      markDone: '标记完成',
      markUndone: '标记未完成',
      archive: '归档',
      unarchive: '取消归档'
    })
    const byId = new Map(
      ALL_STATUS.flatMap((status) => topicStatusActions(status)).map((action) => [action.id, action])
    )
    // 同一个 id 在任何状态下文案与目标一致（不能这次点去 done、那次点去 archived）
    expect(byId.get('learning-mark-done')).toEqual({
      id: 'learning-mark-done',
      label: '标记完成',
      target: 'done'
    })
    expect(byId.get('learning-mark-undone')).toEqual({
      id: 'learning-mark-undone',
      label: '标记未完成',
      target: 'active'
    })
    expect(byId.get('learning-archive')).toEqual({
      id: 'learning-archive',
      label: '归档',
      target: 'archived'
    })
    expect(byId.get('learning-unarchive')).toEqual({
      id: 'learning-unarchive',
      label: '取消归档',
      target: 'active'
    })
  })
})

describe('学习主题：状态可逆（用户原话"标记完成不能取消"、"归档转不回未归档"）', () => {
  /**
   * 点一次"切换类"动作：取出该状态下"打勾 / 归档"那一个按钮的 target，
   * 把它当作新状态——与界面 `onClick={() => updateTopic(id, { status: action.target })}` 同一条路。
   */
  function click(status: TopicStatus, id: TopicStatusActionId): TopicStatus {
    const action = topicStatusActions(status).find((candidate) => candidate.id === id)
    if (action === undefined) throw new Error(`状态 ${status} 下没有 ${id} 这个按钮`)
    return action.target
  }

  it('active → 标记完成 → done → 标记未完成 → 回到 active', () => {
    const done = click('active', 'learning-mark-done')
    expect(done).toBe('done')
    const back = click(done, 'learning-mark-undone')
    expect(back).toBe('active')
    // 回到 active 之后按钮矩阵也回到起点
    expect(idsOf(back)).toEqual(['learning-mark-done', 'learning-archive'])
  })

  it('active → 归档 → archived → 取消归档 → 回到 active', () => {
    const archived = click('active', 'learning-archive')
    expect(archived).toBe('archived')
    const back = click(archived, 'learning-unarchive')
    expect(back).toBe('active')
    expect(idsOf(back)).toEqual(['learning-mark-done', 'learning-archive'])
  })

  it('done → 归档 → archived → 取消归档 → active（不记忆归档前的状态，按已定口径）', () => {
    const done = click('active', 'learning-mark-done')
    const archived = click(done, 'learning-archive')
    expect(archived).toBe('archived')
    // 取消归档一律回 active：原本是"已完成"再归档的，取消后需要再点一次「标记完成」
    const back = click(archived, 'learning-unarchive')
    expect(back).toBe('active')
  })

  it('三态之间来回切换任意多轮都不会卡住（每个状态都至少有一个出口）', () => {
    let status: TopicStatus = 'active'
    const path: TopicStatus[] = [status]
    for (let round = 0; round < 4; round += 1) {
      status = click(status, 'learning-archive')
      path.push(status)
      status = click(status, 'learning-unarchive')
      path.push(status)
    }
    expect(path).toEqual([
      'active',
      'archived',
      'active',
      'archived',
      'active',
      'archived',
      'active',
      'archived',
      'active'
    ])
  })
})
