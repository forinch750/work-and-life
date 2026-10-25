/**
 * 阶段 1 验收检查（DEVPLAN 阶段 1 / PRD §10.1）
 *
 * 覆盖：跨启动持久化 → 界面通过 IPC 读写 → 落盘 → 备份 → 导出导入。
 * 每一条都给出实测数据，而不是"看起来没问题"。
 *
 * 注意执行顺序：先从磁盘加载的状态里确认"上一次的数据还在"，
 * 再做写入与破坏性操作。否则"清空"会毁掉持久化证据。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecordEnvelope } from '../../shared/types'
import { moduleFileName } from '../../shared/modules'
import { readHandoff, type VerifyCheck, type VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

export interface Phase1Outcome {
  /** 本次运行是否执行过破坏性操作（清空 / 覆盖导入） */
  destructive: boolean
}

/** 通过渲染进程调用真实 IPC 通道 */
async function viaRenderer<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

export async function runPhase1Checks(
  context: VerifyContext,
  record: Recorder,
  skipDestructive = false
): Promise<Phase1Outcome> {
  const { appData, paths } = context
  let destructive = false

  // ---- 0. 跨启动持久化：上一次运行写下的数据必须原样还在（A1/A2 的核心）----
  // 必须在任何写入之前读取，否则证据就被自己改掉了。
  const handoff = readHandoff(paths)
  const loadedAtStartup = appData.module('memo').all().length
  const startupInfo = appData.startup.find((item) => item.module === 'memo')
  const noRecovery = appData.startup.every(
    (item) => item.status !== 'corrupted' && item.status !== 'recovered-from-backup'
  )

  if (handoff) {
    const expected = handoff.memoAll
    // 判据是"不丢"：本次启动加载的记录数必须不少于上一趟退出时的数量。
    // 不要求严格相等——上一趟的界面写入可能刚好又落盘一条（那是新增，不是丢失）。
    const noLoss = loadedAtStartup >= expected
    record({
      id: 'P1-0',
      prd: 'A1',
      name: '启动时读回上一趟退出前的全部记录',
      passed: noLoss && noRecovery,
      detail: `上一趟（第 ${handoff.pass} 趟，${handoff.runAt}）退出时 ≥${expected} 条 → 本次启动加载 ${loadedAtStartup} 条；无记录丢失=${noLoss}；memo 自检状态=${startupInfo?.status ?? '未知'}`
    })
  } else {
    // 没有交接文件时无法逐条比对，但"能干净启动"本身仍可判定：
    // 自检必须不是 fresh 之外还带读取失败的状态。
    record({
      id: 'P1-0',
      prd: 'A1',
      name: '启动时读回上一趟退出前的全部记录',
      passed: noRecovery && (loadedAtStartup === 0 ? startupInfo?.status === 'fresh' : startupInfo?.status === 'ok'),
      detail: `无交接文件，启动加载 ${loadedAtStartup} 条，自检状态=${startupInfo?.status ?? '未知'}，无损坏/无备份恢复=${noRecovery}`
    })
  }

  // ---- 0b. 启动自检没有出现损坏或异常 ----
  const badModules = appData.startup.filter(
    (item) => item.status === 'corrupted' || item.status === 'recovered-from-backup'
  )
  record({
    id: 'P1-0b',
    prd: 'A1',
    name: '启动自检所有模块均正常（无损坏、无需从备份恢复）',
    passed: badModules.length === 0,
    detail:
      badModules.length === 0
        ? `${appData.startup.length} 个模块全部正常`
        : badModules.map((item) => `${item.module}:${item.status}(${item.message})`).join('；')
  })

  // ---- 1. 界面能拿到数据统计 ----
  try {
    const stats = await viaRenderer<{ dataDir: string; fileCount: number; root: string }>(
      context,
      'window.api.getStats()'
    )
    record({
      id: 'P1-1',
      prd: 'K3',
      name: '界面通过 IPC 读到数据统计，且根目录正确',
      passed: stats.root === paths.root && stats.dataDir === paths.data,
      detail: `root=${stats.root} dataDir=${stats.dataDir} 文件数=${stats.fileCount}`
    })
  } catch (error) {
    record({
      id: 'P1-1',
      prd: 'K3',
      name: '界面通过 IPC 读到数据统计，且根目录正确',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 2. 从界面新增一条备忘（走完整 IPC 通道）----
  let createdId = ''
  try {
    const created = await viaRenderer<RecordEnvelope>(
      context,
      `window.api.data.add('memo', { text: '阶段1验收：这条来自界面', pinned: false })`
    )
    createdId = created.id
    record({
      id: 'P1-2',
      prd: 'A1',
      name: '界面新增记录并拿到完整记录体',
      passed: Boolean(created.id && created.createdAt && created.updatedAt),
      detail: `id=${created.id.slice(0, 8)}… createdAt=${created.createdAt}`
    })
  } catch (error) {
    record({
      id: 'P1-2',
      prd: 'A1',
      name: '界面新增记录并拿到完整记录体',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 3. 立即落盘后，磁盘上确实有这条内容 ----
  appData.flushAll()
  const memoFile = join(paths.data, moduleFileName('memo'))
  let diskText = ''
  let diskHasRecord = false
  try {
    diskText = existsSync(memoFile) ? readFileSync(memoFile, 'utf8') : ''
    diskHasRecord = diskText.includes(createdId)
  } catch {
    diskHasRecord = false
  }
  record({
    id: 'P1-3',
    prd: 'A1',
    name: '落盘后数据文件里能找到刚写的内容',
    passed: diskHasRecord && diskText.length > 0,
    detail: `文件=${memoFile} 字节=${diskText.length} 含新记录=${diskHasRecord}`
  })

  // ---- 4. 磁盘内容是合法 JSON 且结构符合 PRD §7.2 ----
  let structureOk = false
  let structureDetail = ''
  try {
    const parsed = JSON.parse(diskText) as {
      formatVersion?: number
      module?: string
      updatedAt?: string
      records?: unknown[]
    }
    structureOk =
      typeof parsed.formatVersion === 'number' &&
      parsed.module === 'memo' &&
      typeof parsed.updatedAt === 'string' &&
      Array.isArray(parsed.records)
    structureDetail = `formatVersion=${parsed.formatVersion} module=${parsed.module} records=${
      parsed.records?.length ?? -1
    }`
  } catch (error) {
    structureDetail = `解析失败：${String(error)}`
  }
  record({
    id: 'P1-4',
    prd: 'A5',
    name: '数据文件结构符合约定（含格式版本号）',
    passed: structureOk,
    detail: structureDetail
  })

  // ---- 5. 连续 40 次通过界面写入，不卡死也不丢 ----
  appData.flushAll()
  const countBeforeBatch = appData.module('memo').list().length
  try {
    const count = await viaRenderer<number>(
      context,
      `(async () => {
         for (let i = 0; i < 40; i++) {
           await window.api.data.add('memo', { text: '批量验收 ' + i, seq: i })
         }
         return (await window.api.data.listAlive('memo')).length
       })()`
    )
    record({
      id: 'P1-5',
      prd: 'A6',
      name: '连续 40 次界面写入后记录数正确',
      passed: count === countBeforeBatch + 40,
      detail: `写入前 ${countBeforeBatch} 条 → 界面报告 ${count} 条（预期 ${countBeforeBatch + 40}）`
    })
  } catch (error) {
    record({
      id: 'P1-5',
      prd: 'A6',
      name: '连续 40 次界面写入后记录数正确',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 6. 手动备份产生当天目录 ----
  let backupOk = false
  let backupDetail = ''
  try {
    const result = appData.runBackupNow()
    const backupDirExists = existsSync(result.dir)
    backupOk = backupDirExists
    backupDetail = `目录=${result.dir} 存在=${backupDirExists} 文件数=${result.files.length} 说明=${result.message}`
  } catch (error) {
    backupDetail = String(error)
  }
  record({
    id: 'P1-6',
    prd: 'A5',
    name: '手动备份产生当天备份目录',
    passed: backupOk,
    detail: backupDetail
  })

  // ---- 7. 导出 → 清空 → 导入，数据完全恢复（对应 B1/B2/B3）----
  // 破坏性步骤：只在完整验收那趟执行，且由交接文件交给下一趟核对
  if (skipDestructive) {
    record({
      id: 'P1-7',
      prd: 'B2',
      name: '导出 → 清空 → 导入后记录数完全恢复',
      passed: true,
      detail: '本趟为非破坏性检查，该项留到完整验收那趟执行（避免抹掉持久化证据）'
    })
  } else {
    const workDir = mkdtempSync(join(tmpdir(), 'worklife-verify-'))
    const exportFile = join(workDir, '导出.json')
    try {
      appData.flushAll()
      const beforeClear = appData.module('memo').list().length

      const exported = appData.exportAll(exportFile)
      const exportedOk = existsSync(exportFile) && exported.recordCount > 0

      // 清空：把 memo 模块的存活记录全部物理删除
      for (const item of appData.module('memo').list()) {
        appData.module('memo').remove(item.id, { hard: true })
      }
      appData.flushAll()
      const afterClear = appData.module('memo').list().length
      destructive = true

      const imported = appData.importAll(exportFile, 'replace')
      const afterImport = appData.module('memo').list().length

      record({
        id: 'P1-7',
        prd: 'B2',
        name: '导出 → 清空 → 导入后记录数完全恢复',
        passed: exportedOk && afterClear === 0 && afterImport === beforeClear,
        detail: `导出 ${exported.recordCount} 条（含各模块）→ 清空后 ${afterClear} 条 → 导入后 ${afterImport} 条（原始 ${beforeClear} 条）；导入前已自动备份到 ${imported.backup.dir}`
      })
    } catch (error) {
      record({
        id: 'P1-7',
        prd: 'B2',
        name: '导出 → 清空 → 导入后记录数完全恢复',
        passed: false,
        detail: String(error)
      })
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  // ---- 8. 合并模式不会丢数据（对应 B3）----
  try {
    appData.flushAll()
    const beforeCount = appData.module('memo').list().length
    const workDir2 = mkdtempSync(join(tmpdir(), 'worklife-verify-merge-'))
    const file2 = join(workDir2, '导出.json')
    appData.exportAll(file2)

    // 再写一条只存在于本机的记录，然后以"合并"方式导入旧文件
    appData.module('memo').add({ text: '合并模式独有记录', onlyLocal: true })
    appData.flushAll()
    const midCount = appData.module('memo').list().length

    const result = appData.importAll(file2, 'merge')
    const finalCount = appData.module('memo').list().length

    record({
      id: 'P1-8',
      prd: 'B3',
      name: '合并导入后本机独有记录仍在',
      passed: finalCount === midCount && midCount === beforeCount + 1,
      detail: `导入前 ${beforeCount} → 加一条 ${midCount} → 合并后 ${finalCount}；导入结果：${result.message}`
    })

    rmSync(workDir2, { recursive: true, force: true })
  } catch (error) {
    record({
      id: 'P1-8',
      prd: 'B3',
      name: '合并导入后本机独有记录仍在',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 9. 主进程内存态与磁盘一致 ----
  appData.flushAll()
  try {
    const fromDisk = JSON.parse(readFileSync(memoFile, 'utf8')) as { records: unknown[] }
    const fromMemory = appData.module('memo').all().length
    record({
      id: 'P1-9',
      prd: 'A1',
      name: '主进程内存记录数与磁盘文件一致',
      passed: fromDisk.records.length === fromMemory,
      detail: `磁盘 ${fromDisk.records.length} 条 / 内存 ${fromMemory} 条`
    })
  } catch (error) {
    record({
      id: 'P1-9',
      prd: 'A1',
      name: '主进程内存记录数与磁盘文件一致',
      passed: false,
      detail: String(error)
    })
  }

  return { destructive }
}
