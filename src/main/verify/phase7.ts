/**
 * 阶段 7 验收检查（第二轮 FEAT-009：回收站）
 *
 * 覆盖用户确认的回收站定义：
 *   - **只针对单个条目**：某个主题/书/备忘不要了，先扔进去以防万一
 *   - **不是"清空全部数据"**：清空是物理删除，不走回收站
 *   - 能看（删除时间 / 原位置 / 数据类型）、能恢复、能彻底删、能设自动清理期限
 *
 * 这也是 BUG-007（学习主题与书可删除）的验收出口：
 * 删除后必须能在回收站里找到，否则"删了"就等于"丢了"。
 */
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runPhase7Checks(
  context: VerifyContext,
  record: Recorder,
  passNumber: number
): Promise<void> {
  const marker = `阶段7回收站（第${passNumber}趟）`

  // 先确保在设置页（回收站就挂在这里）
  await evaluate(context, `window.__verify.clickNav('settings')`)
  await wait(300)

  // ---- T1 删除的条目出现在回收站，并显示类型/原位置/删除时间 ----
  try {
    // 在备忘页删除，而不是在设置页偷偷删：
    // 用户实际的删除动作发生在各自的模块页，验收要照着走
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(300)
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(`${marker} 待删除的备忘`)}, pinned: false })`
    )
    await evaluate(context, `window.api.data.remove('memo', ${JSON.stringify(created.id)})`)
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const listed = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.trash.list()`
    )
    const mine = listed.find((item) => item['id'] === created.id)
    const fieldsOk =
      mine !== undefined &&
      String(mine['typeLabel'] ?? '') === '备忘' &&
      String(mine['origin'] ?? '') === '备忘录' &&
      typeof mine['deletedAt'] === 'string' &&
      String(mine['deletedAt']) !== '' &&
      String(mine['title'] ?? '').includes(marker)

    // 再进设置页：回收站要在界面上真的显示出这一条（而不是只在数据层存在）
    await evaluate(context, `window.__verify.clickNav('settings')`)
    await wait(500)
    const uiCount = await evaluate<number>(
      context,
      `window.__verify.count('[data-testid="trash-item"]')`
    )
    const uiShowsMine = await evaluate<boolean>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="trash-item"]'))
         return items.some((el) => (el.textContent || '').includes(${JSON.stringify(marker)}))
       })()`
    )

    record({
      id: 'P7-T1',
      prd: 'FEAT-009',
      name: '删除后条目出现在回收站，并显示数据类型、原位置与删除时间',
      passed: fieldsOk && uiCount >= 1 && uiShowsMine,
      detail: `回收站条目数=${listed.length}，界面显示=${uiCount}，界面上能找到该条=${uiShowsMine}；该条类型=${String(mine?.['typeLabel'])}，原位置=${String(mine?.['origin'])}，删除时间=${String(mine?.['deletedAt']).slice(0, 19)}`
    })
  } catch (error) {
    record({
      id: 'P7-T1',
      prd: 'FEAT-009',
      name: '删除后条目出现在回收站，并显示数据类型、原位置与删除时间',
      passed: false,
      detail: String(error)
    })
  }

  // ---- T2 恢复：条目回到原位置，且不再出现在回收站 ----
  try {
    const before = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)
    const target = before.find((item) => String(item['title'] ?? '').includes(marker))
    if (!target) throw new Error('回收站里找不到刚才那条备忘')

    // 通过界面点「恢复」，验证按钮真的可用（而不是只测 IPC）
    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="trash-item"]'))
         const hit = items.find((el) => (el.textContent || '').includes(${JSON.stringify(marker)}))
         if (!hit) return false
         const button = hit.querySelector('[data-testid="trash-restore"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )

    // 轮询等待界面把列表刷新掉（恢复是异步的，固定延时在慢机器上不够）
    let stillInTrash = true
    let uiStillShows = true
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(200)
      const after = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)
      stillInTrash = after.some((item) => item['id'] === target['id'])
      uiStillShows = await evaluate<boolean>(
        context,
        `(() => {
           const items = Array.from(document.querySelectorAll('[data-testid="trash-item"]'))
           return items.some((el) => (el.textContent || '').includes(${JSON.stringify(marker)}))
         })()`
      )
      if (!stillInTrash && !uiStillShows) break
    }

    // 回原位置：memo 模块的存活记录里应当能再看到它
    const aliveMemos = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('memo')`
    )
    const backAlive = aliveMemos.some((item) => item['id'] === target['id'])

    record({
      id: 'P7-T2',
      prd: 'FEAT-009',
      name: '恢复后条目回到原位置，且不再出现在回收站',
      passed: clicked && !stillInTrash && !uiStillShows && backAlive,
      detail: `点到恢复按钮=${clicked}；列表里已消失=${!stillInTrash}；界面不再显示=${!uiStillShows}；回到备忘录存活列表=${backAlive}（回收站 ${before.length} 项）`
    })
  } catch (error) {
    record({
      id: 'P7-T2',
      prd: 'FEAT-009',
      name: '恢复后条目回到原位置，且不再出现在回收站',
      passed: false,
      detail: String(error)
    })
  }

  // ---- T3 彻底删除：从数据文件里真正消失 ----
  try {
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(`${marker} 待彻底删除`)}, pinned: false })`
    )
    await evaluate(context, `window.api.data.remove('memo', ${JSON.stringify(created.id)})`)
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const purgeOk = await evaluate<boolean>(
      context,
      `window.api.trash.purge('memo', ${JSON.stringify(created.id)})`
    )
    await wait(300)
    // all() 含软删除；彻底删除后连 all() 都不该有
    const allRecords = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.list('memo')`
    )
    const gone = !allRecords.some((item) => item['id'] === created.id)

    record({
      id: 'P7-T3',
      prd: 'FEAT-009',
      name: '彻底删除后记录从数据里真正消失（连软删除记录都不再有）',
      passed: purgeOk && gone,
      detail: `purge 返回=${purgeOk}；数据里已无该条=${gone}`
    })
  } catch (error) {
    record({
      id: 'P7-T3',
      prd: 'FEAT-009',
      name: '彻底删除后记录从数据里真正消失（连软删除记录都不再有）',
      passed: false,
      detail: String(error)
    })
  }

  // ---- T4 保留期限可设，且设置值会落盘 ----
  try {
    // 通过界面下拉框改成 7 天
    const setOk = await evaluate<boolean>(
      context,
      `window.__verify.setSelect('trash-keep-days', '7')`
    )
    await wait(600)
    const saved = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('app')`
    )
    const prefs = saved.find((item) => item['id'] === 'preferences')
    const persisted = Number(prefs?.['trashKeepDays']) === 7

    // 改回 30 天，避免影响后续趟次
    await evaluate(context, `window.__verify.setSelect('trash-keep-days', '30')`)
    await wait(500)

    record({
      id: 'P7-T4',
      prd: 'FEAT-009',
      name: '回收站保留期限可设置（7 天 / 30 天 / 永久）并写入数据文件',
      passed: setOk && persisted,
      detail: `下拉框可设=${setOk}；落盘 trashKeepDays=${String(prefs?.['trashKeepDays'])}（期望 7）`
    })
  } catch (error) {
    record({
      id: 'P7-T4',
      prd: 'FEAT-009',
      name: '回收站保留期限可设置（7 天 / 30 天 / 永久）并写入数据文件',
      passed: false,
      detail: String(error)
    })
  }

  // ---- T5 按期限清理：过期条目被物理删除，未过期的留着 ----
  try {
    // 造两条：一条"很久以前删的"，一条"刚删的"
    const oldOne = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(`${marker} 过期条目`)}, pinned: false })`
    )
    const freshOne = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(`${marker} 未过期条目`)}, pinned: false })`
    )
    await evaluate(context, `window.api.data.remove('memo', ${JSON.stringify(oldOne.id)})`)
    await evaluate(context, `window.api.data.remove('memo', ${JSON.stringify(freshOne.id)})`)
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    // 把"过期条目"的删除时间改到 60 天前
    const oldStamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    await evaluate(
      context,
      `window.api.data.update('memo', ${JSON.stringify(oldOne.id)}, { deletedAt: ${JSON.stringify(oldStamp)} })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const purgeResult = await evaluate<{ removed: number }>(
      context,
      `window.api.trash.purgeExpired(30)`
    )
    await wait(400)

    const allMemos = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.list('memo')`
    )
    const oldGone = !allMemos.some((item) => item['id'] === oldOne.id)
    const freshKept = allMemos.some((item) => item['id'] === freshOne.id)

    // 收尾：把未过期那条也彻底清掉，别给数据库留垃圾
    await evaluate(context, `window.api.trash.purge('memo', ${JSON.stringify(freshOne.id)})`)

    record({
      id: 'P7-T5',
      prd: 'FEAT-009',
      name: '按保留期限清理：超过期限的彻底删除，未过期的保留',
      passed: oldGone && freshKept && purgeResult.removed >= 1,
      detail: `清理 ${purgeResult.removed} 项；60 天前的已删除=${oldGone}；刚删的仍保留=${freshKept}`
    })
  } catch (error) {
    record({
      id: 'P7-T5',
      prd: 'FEAT-009',
      name: '按保留期限清理：超过期限的彻底删除，未过期的保留',
      passed: false,
      detail: String(error)
    })
  }

  // ---- T6 「清空全部数据」不经过回收站（用户确认的唯一例外）----
  try {
    const before = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)
    const result = await evaluate<{ cleared: boolean; removed: number }>(
      context,
      `window.api.clearAll({ force: true, skipDialog: true })`
    )
    await wait(500)
    const after = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)

    // 清空之后回收站必须是空的：说明清空是物理删除，没有把东西塞进回收站
    const trashEmptied = after.length === 0

    record({
      id: 'P7-T6',
      prd: 'B4',
      name: '「清空全部数据」是物理删除，不经过回收站（唯一例外）',
      passed: result.cleared && trashEmptied,
      detail: `清空 ${result.removed} 条；清空前回收站 ${before.length} 项 → 清空后 ${after.length} 项（应为 0）`
    })
  } catch (error) {
    record({
      id: 'P7-T6',
      prd: 'B4',
      name: '「清空全部数据」是物理删除，不经过回收站（唯一例外）',
      passed: false,
      detail: String(error)
    })
  }
}
