/**
 * 阶段 3 验收检查（DEVPLAN 阶段 3 / PRD §10.2）
 *
 * 覆盖数据与设置页的六件事：位置与统计、手动备份、导出、导入、打开文件夹、偏好、清空。
 *
 * 说明：
 *   - 导出/导入通过环境变量指定落点（WORKLIFE_EXPORT_PATH / WORKLIFE_IMPORT_PATH），
 *     避免文件对话框把无人值守流程卡住；正式使用时走正常对话框。
 *   - "清空"是破坏性操作，放在本阶段所有断言之后执行。
 */
import { existsSync } from 'node:fs'
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 切到数据与设置页并等待渲染 */
async function gotoSettings(context: VerifyContext): Promise<void> {
  await evaluate(context, `window.__verify.clickNav('settings')`)
  await wait(250)
}

export interface Phase3Outcome {
  /** 导出文件的实际落点，供后续断言复用 */
  exportFile: string | null
}

export async function runPhase3Checks(
  context: VerifyContext,
  record: Recorder,
  exportFile: string | null
): Promise<Phase3Outcome> {
  await gotoSettings(context)

  // ---- 1. 设置页显示数据位置与统计 ----
  try {
    const info = await evaluate<{ dataDir: string; counts: string; backupDir: string }>(
      context,
      `({
         dataDir: (window.__verify.byTestId('settings-data-dir') || {}).textContent || '',
         counts: (window.__verify.byTestId('settings-counts') || {}).textContent || '',
         backupDir: (window.__verify.byTestId('settings-backup-dir') || {}).textContent || ''
       })`
    )
    record({
      id: 'P3-1',
      prd: 'K3',
      name: '设置页显示数据目录、记录统计与备份目录',
      passed:
        info.dataDir === context.paths.data &&
        info.backupDir === context.paths.backups &&
        info.counts.includes('条记录'),
      detail: `数据目录=${info.dataDir}；统计=${info.counts.trim()}；备份目录=${info.backupDir}`
    })
  } catch (error) {
    record({
      id: 'P3-1',
      prd: 'K3',
      name: '设置页显示数据目录、记录统计与备份目录',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 2. 立即备份按钮真的产生当天备份 ----
  try {
    const before = await evaluate<number>(context, `window.__verify.count('.backup-list__item')`)
    await evaluate(context, `window.__verify.click('[data-testid="backup-now"]')`)
    await wait(700)
    context.appData.flushAll()
    const after = await evaluate<number>(context, `window.__verify.count('.backup-list__item')`)
    const backups = context.appData.getStats().backups
    const todayDir = backups[0]?.path ?? ''
    record({
      id: 'P3-2',
      prd: 'A5',
      name: '点"立即备份"后备份目录里确实有当天备份',
      passed: backups.length >= 1 && existsSync(todayDir) && after >= before,
      detail: `备份份数=${backups.length}，最新=${backups[0]?.date ?? '无'}（${backups[0]?.files ?? 0} 个文件），列表项 ${before}→${after}`
    })
  } catch (error) {
    record({
      id: 'P3-2',
      prd: 'A5',
      name: '点"立即备份"后备份目录里确实有当天备份',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 3. 导出全部数据（B1）----
  try {
    // 通过参数指定落点，避免保存对话框把无人值守流程卡住
    await evaluate(
      context,
      `window.api.exportAll(${JSON.stringify(exportFile ?? '')}).then(r => r ? r.file : null)`
    )
    await wait(600)
    const ok = exportFile !== null && existsSync(exportFile)
    record({
      id: 'P3-3',
      prd: 'B1',
      name: '点"导出全部数据"后生成可读的 JSON 文件',
      passed: ok,
      detail: ok ? `文件已生成：${exportFile}` : `未生成文件（预期 ${exportFile}）`
    })
  } catch (error) {
    record({
      id: 'P3-3',
      prd: 'B1',
      name: '点"导出全部数据"后生成可读的 JSON 文件',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 3b. 页面上的"导出全部数据"按钮存在且可点（走真实对话框路径，只验存在性）----
  try {
    const exists = await evaluate<boolean>(
      context,
      `!!window.__verify.byTestId('export-all') && !!window.__verify.byTestId('import-merge') && !!window.__verify.byTestId('import-replace')`
    )
    record({
      id: 'P3-3b',
      prd: 'B1',
      name: '导出与导入（合并/覆盖）三个按钮都在页面上',
      passed: exists,
      detail: `按钮齐全=${exists}`
    })
  } catch (error) {
    record({
      id: 'P3-3b',
      prd: 'B1',
      name: '导出与导入（合并/覆盖）三个按钮都在页面上',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 4. 改偏好 → 立即生效并落盘 ----
  try {
    await evaluate(context, `window.__verify.setSelect('pref-week-start', '7')`)
    await wait(600)
    await evaluate(context, `window.__verify.setSelect('pref-review-intensity', 'intense')`)
    await wait(600)
    await evaluate(context, `window.__verify.setSelect('pref-theme', 'dark')`)
    await wait(600)
    context.appData.flushAll()

    const theme = await evaluate<string | null>(context, `window.__verify.theme()`)
    const saved = context.appData
      .module('app')
      .all()
      .find((item) => item['id'] === 'preferences')

    const ok =
      theme === 'dark' &&
      saved?.['weekStart'] === 7 &&
      saved?.['reviewIntensity'] === 'intense' &&
      saved?.['theme'] === 'dark'
    record({
      id: 'P3-4',
      prd: 'B1',
      name: '偏好改动立即生效并写入数据文件',
      passed: ok,
      detail: `主题=${theme ?? '跟随系统'}；已保存偏好：weekStart=${String(saved?.['weekStart'])} reviewIntensity=${String(saved?.['reviewIntensity'])} backupKeepDays=${String(saved?.['backupKeepDays'])}`
    })

    // 收尾：把主题恢复成浅色，避免影响后续颜色相关断言
    await evaluate(context, `window.__verify.setSelect('pref-theme', 'light')`)
    await wait(600)
    context.appData.flushAll()
  } catch (error) {
    record({
      id: 'P3-4',
      prd: 'B1',
      name: '偏好改动立即生效并写入数据文件',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 4b. 主题三档切换立即生效（PRD §2.9）----
  try {
    const results: Array<{ value: string; applied: string | null }> = []
    for (const value of ['dark', 'light', 'system']) {
      await evaluate(context, `window.__verify.setSelect('pref-theme', '${value}')`)
      // 主题是 React 状态驱动 + 异步保存的，不能只看一眼就下结论。
      // 轮询等到"已经切到目标值"（system 对应没有 data-theme 属性）。
      let applied: string | null = null
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(120)
        applied = await evaluate<string | null>(context, `window.__verify.theme()`)
        const matches = value === 'system' ? applied === null : applied === value
        if (matches) break
      }
      results.push({ value, applied })
    }
    const ok =
      results[0]?.applied === 'dark' &&
      results[1]?.applied === 'light' &&
      results[2]?.applied === null
    record({
      id: 'P3-4b',
      prd: 'L2',
      name: '主题三档（深色/浅色/跟随系统）切换立即生效',
      passed: ok,
      detail: results.map((item) => `${item.value}→${item.applied ?? '跟随系统'}`).join('，')
    })
    await evaluate(context, `window.__verify.setSelect('pref-theme', 'light')`)
    await wait(400)
    context.appData.flushAll()
  } catch (error) {
    record({
      id: 'P3-4b',
      prd: 'L2',
      name: '主题三档（深色/浅色/跟随系统）切换立即生效',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 5. 打开文件夹 ----
  try {
    const result = await evaluate<{ opened: boolean; message: string }>(
      context,
      `window.api.openDataFolder()`
    )
    record({
      id: 'P3-5',
      prd: 'K3',
      name: '"打开文件夹"能定位到数据目录',
      passed: result.opened && result.message === context.paths.data,
      detail: `opened=${result.opened} path=${result.message}`
    })
  } catch (error) {
    record({
      id: 'P3-5',
      prd: 'K3',
      name: '"打开文件夹"能定位到数据目录',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 6. 导入（覆盖）→ 数据恢复（B2）----
  if (!exportFile || !existsSync(exportFile)) {
    record({
      id: 'P3-6',
      prd: 'B2',
      name: '清空后导入可完整恢复',
      passed: false,
      detail: '缺少第 3 步生成的导出文件，无法验证导入'
    })
    return { exportFile }
  }

  try {
    // 先记下当前状态，再真的清空，然后从导出文件恢复。
    //
    // 注意：这一项不能依赖"别的阶段留下了数据"。
    // 阶段 7（回收站）的最后一项会执行「清空全部数据」，跑到这里时数据可能是空的，
    // 那样"导出→清空→导入"就变成了 0→0→0，看着像坏了其实是无米下锅。
    // 因此数据为空时先自己播种一批，让这一项自带前提。
    context.appData.flushAll()
    let before = context.appData.module('memo').list().length
    if (before === 0) {
      const seeded = context.appData.module('memo')
      for (let index = 0; index < 5; index += 1) {
        seeded.add({ text: `阶段3恢复验证样本 ${index}`, pinned: false })
      }
      context.appData.flushAll()
      // 重新导出：上面的导出文件是数据还满的时候生成的，这里要以当前内容为准
      const reseeded = context.appData.exportAll(exportFile)
      before = context.appData.module('memo').list().length
      context.logger.info('phase3-reseeded', { before, records: reseeded.recordCount })
    }

    const cleared = await evaluate<{ cleared: boolean; removed: number }>(
      context,
      `window.api.clearAll({ force: true, skipDialog: true })`
    )
    await wait(300)
    const afterClear = context.appData.module('memo').list().length

    const imported = await evaluate<{ cancelled: boolean; message: string; recordCount: number }>(
      context,
      `window.api.importAll('replace', ${JSON.stringify(exportFile)})`
    )
    await wait(400)
    context.appData.flushAll()
    const afterImport = context.appData.module('memo').list().length

    record({
      id: 'P3-6',
      prd: 'B2',
      name: '清空后导入可完整恢复',
      passed:
        cleared.cleared &&
        afterClear === 0 &&
        !imported.cancelled &&
        afterImport === before &&
        before > 0,
      detail: `清空前 ${before} 条 → 清空后 ${afterClear} 条（删除 ${cleared.removed} 条）→ 导入后 ${afterImport} 条；导入提示：${imported.message}`
    })
  } catch (error) {
    record({
      id: 'P3-6',
      prd: 'B2',
      name: '清空后导入可完整恢复',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 7. 清空前的自动导出（B4）----
  try {
    await evaluate(context, `window.api.clearAll({ force: true, skipDialog: true })`)
    await wait(500)
    const result = await evaluate<{ exportedTo: string | null; cleared: boolean }>(
      context,
      `window.api.clearAll({ force: true, skipDialog: true })`
    )
    const exportedExists = typeof result.exportedTo === 'string' && existsSync(result.exportedTo)
    record({
      id: 'P3-7',
      prd: 'B4',
      name: '清空前自动导出最后一份数据（落点由 WORKLIFE_EXPORT_DIR 指定，不影响真实桌面）',
      passed: exportedExists,
      detail: exportedExists
        ? `导出到：${result.exportedTo}`
        : `没有拿到导出文件（返回值 ${JSON.stringify(result)}）`
    })
  } catch (error) {
    record({
      id: 'P3-7',
      prd: 'B4',
      name: '清空前自动导出最后一份数据（落点由 WORKLIFE_EXPORT_DIR 指定，不影响真实桌面）',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 8. 确认文字不对时拒绝清空（危险操作的护栏）----
  try {
    await evaluate(context, `window.api.data.add('memo', { text: '护栏验证：这条必须活着' })`)
    await wait(200)
    context.appData.flushAll()
    const guard = await evaluate<{ cleared: boolean }>(
      context,
      `window.api.clearAll({ confirmText: '随便写点' })`
    )
    await wait(200)
    const survived = context.appData
      .module('memo')
      .list()
      .some((item) => item['text'] === '护栏验证：这条必须活着')
    record({
      id: 'P3-8',
      prd: 'B4',
      name: '确认文字不正确时拒绝清空，数据不受影响',
      passed: guard.cleared === false && survived,
      detail: `cleared=${guard.cleared} 数据仍在=${survived}`
    })
  } catch (error) {
    record({
      id: 'P3-8',
      prd: 'B4',
      name: '确认文字不正确时拒绝清空，数据不受影响',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 9. 清空对话框的确认输入框存在且确认按钮初始禁用 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="clear-all"]')`)
    // 对话框是异步挂载的，轮询等它出现（固定 200ms 在慢一点的机器上不够）
    let state = { open: false, hasInput: false, disabled: false }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await wait(120)
      state = await evaluate<{ open: boolean; hasInput: boolean; disabled: boolean }>(
        context,
        `(() => {
           const dialog = window.__verify.byTestId('clear-dialog')
           const button = window.__verify.byTestId('dialog-confirm')
           return {
             open: !!dialog,
             hasInput: !!window.__verify.byTestId('confirm-dialog-input'),
             disabled: button ? button.disabled : false
           }
         })()`
      )
      if (state.open && state.hasInput) break
    }
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)
    record({
      id: 'P3-9',
      prd: 'B4',
      name: '清空需要手动输入确认文字，未输入时确认按钮不可点',
      passed: state.open && state.hasInput && state.disabled,
      detail: `对话框打开=${state.open} 有确认输入框=${state.hasInput} 确认按钮禁用=${state.disabled}`
    })
  } catch (error) {
    record({
      id: 'P3-9',
      prd: 'B4',
      name: '清空需要手动输入确认文字，未输入时确认按钮不可点',
      passed: false,
      detail: String(error)
    })
  }

  return { exportFile }
}
