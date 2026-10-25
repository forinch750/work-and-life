/**
 * 数据与设置页（DEVPLAN 阶段 3 / PRD §5.7）
 *
 * 这一页是"数据不会丢"这条需求的界面出口：位置能看到、备份能手动做、
 * 导出能拿到文件、导入有合并与覆盖两条路、清空要手动输入确认。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataStats } from '../../../shared/types'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_ID,
  PREFERENCES_MODULE,
  clampKeepDays,
  hotkeyOverrides,
  normalizePreferences,
  readPreferences,
  resolveHotkeys,
  type AppPreferences,
  type HotkeyAction,
  type ReviewIntensity,
  type ThemePreference,
  type WeekStart
} from '../../../shared/preferences'
import { getDataApi, getStats } from '../../lib/dataClient'
import { notifyDataChanged } from '../../lib/dataEvents'
import { applyTheme } from '../../lib/theme'
import { PageShell } from '../../shell/PageShell'
import { ConfirmDialog } from '../../shell/Editors'
import { HotkeySection } from './HotkeySection'
import { GuideSection } from './GuideSection'
import { TrashSection } from './TrashSection'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function SettingsPage(): React.JSX.Element {
  const [stats, setStats] = useState<DataStats | null>(null)
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFERENCES)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)

  const refresh = useCallback(async () => {
    const [nextStats, records] = await Promise.all([
      getStats(),
      getDataApi().list(PREFERENCES_MODULE)
    ])
    setStats(nextStats)
    setPrefs(readPreferences(records as Array<Record<string, unknown>>))
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason))
    )
  }, [refresh])

  const notify = (text: string): void => {
    setMessage(text)
    setError(null)
    setTimeout(() => setMessage(null), 2600)
  }

  /** 保存偏好：没有偏好记录就新建一条，有就更新 */
  const savePrefs = async (patch: Partial<AppPreferences>): Promise<void> => {
    const next = normalizePreferences({ ...prefs, ...patch })
    setPrefs(next)
    if (patch.theme) applyTheme(patch.theme)

    /**
     * 落库内容。
     *
     * `api.update` 是**合并**语义（`{...当前记录, ...patch}`），所以"没提这个字段"
     * 等于"保留旧值"。而 `normalizePreferences` 会把"全部恢复默认"的快捷键表
     * （空对象）整个丢掉——那样数据里旧的覆盖值就会一直留着，界面上看着已重置、
     * 实际还是老绑定。因此这里显式把绑定表写回去（哪怕是空对象 `{}`）。
     */
    const payload: Record<string, unknown> = { ...(next as unknown as Record<string, unknown>) }
    if (patch.hotkeys !== undefined) payload['hotkeys'] = patch.hotkeys

    const api = getDataApi()
    const records = (await api.list(PREFERENCES_MODULE)) as Array<Record<string, unknown>>
    const existing = records.find((record) => record['id'] === PREFERENCES_ID)
    if (existing) {
      await api.update(PREFERENCES_MODULE, PREFERENCES_ID, payload)
    } else {
      await api.add(PREFERENCES_MODULE, { id: PREFERENCES_ID, ...payload })
    }
    // 显式落盘：偏好是"设置完就应当立即生效并保存"的东西，不等防抖窗口
    await api.flush()
    await getDataApi().flush()
    // 把"偏好变了"广播出去：`App.tsx` 靠它重读快捷键绑定与周起始日，
    // 否则改完要重启才生效（周起始日以前就是这样，05 块才接上）
    notifyDataChanged('app')
    await refresh()
    notify('偏好已保存')
  }

  /** 当前生效的完整绑定表（默认值打底 + 改过的覆盖） */
  const bindings = useMemo(() => resolveHotkeys(prefs.hotkeys), [prefs.hotkeys])

  /**
   * 保存快捷键绑定。
   *
   * 只写"与默认值不同"的那些（`hotkeyOverrides`）：偏好记录里不该躺着一份
   * 与代码默认值一模一样的表——那样以后改默认值就再也影响不到老用户了。
   */
  const onSaveHotkeys = (next: Record<HotkeyAction, string>, message: string): void => {
    void savePrefs({ hotkeys: hotkeyOverrides(next) })
    notify(message)
  }

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const text = await action()
      if (text) notify(text)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const onOpenFolder = (): void =>
    void run(async () => {
      const result = await window.api.openDataFolder()
      return result.opened ? `已打开：${result.message}` : `打开失败：${result.message}`
    })

  const onBackupNow = (): void =>
    void run(async () => {
      const result = await window.api.backupNow()
      return result.created ? result.message : `${result.message}（未新增备份）`
    })

  const onExport = (): void =>
    void run(async () => {
      const result = await window.api.exportAll()
      if (!result) return '已取消导出'
      return `已导出 ${result.recordCount} 条记录到：${result.file}`
    })

  const onImport = (mode: 'merge' | 'replace'): void =>
    void run(async () => {
      const result = await window.api.importAll(mode)
      if (result.cancelled) return result.message
      return `${result.message}（导入前已自动备份）`
    })

  const onClear = (): void => {
    setClearOpen(false)
    void run(async () => {
      const result = await window.api.clearAll({ confirmText: '清空' })
      if (!result.cleared) return result.message
      return `${result.message}${result.exportedTo ? `；清空前已导出到 ${result.exportedTo}` : ''}`
    })
  }

  const backupDir = stats?.backupDir ?? ''
  const latestBackups = stats?.backups.slice(0, 5) ?? []

  return (
    <PageShell title="数据与设置" description="数据在哪、怎么备份、怎么换电脑">
      <section className="panel" data-testid="settings-location">
        <h2 className="panel__title">数据存放位置</h2>
        <dl className="kv">
          <div className="kv__row">
            <dt>数据目录</dt>
            <dd data-testid="settings-data-dir">{stats?.dataDir ?? '读取中…'}</dd>
          </div>
          <div className="kv__row">
            <dt>内容</dt>
            <dd data-testid="settings-counts">
              {stats ? `${stats.recordCount} 条记录 · ${stats.fileCount} 个数据文件 · ${formatBytes(stats.bytes)}` : '读取中…'}
            </dd>
          </div>
          <div className="kv__row">
            <dt>备份目录</dt>
            <dd data-testid="settings-backup-dir">{backupDir || '读取中…'}</dd>
          </div>
          <div className="kv__row">
            <dt>启动自检</dt>
            <dd data-testid="settings-selfcheck">
              {stats
                ? stats.startup.every(
                    (item) => item.status === 'ok' || item.status === 'fresh' || item.status === 'migrated'
                  )
                  ? '全部正常'
                  : `有异常：${stats.startup
                      .filter(
                        (item) =>
                          item.status !== 'ok' &&
                          item.status !== 'fresh' &&
                          item.status !== 'migrated'
                      )
                      .map((item) => `${item.module}(${item.status})`)
                      .join('、')}`
                : '读取中…'}
            </dd>
          </div>
        </dl>
        <div className="panel__actions">
          <button type="button" className="button" onClick={onOpenFolder} data-testid="open-folder">
            打开文件夹
          </button>
        </div>
      </section>

      <section className="panel" data-testid="settings-backup">
        <h2 className="panel__title">备份</h2>
        <p className="panel__hint">
          每次启动程序时自动备份一次，保留最近 {prefs.backupKeepDays} 份。
          {stats ? ` 当前有 ${stats.backups.length} 份。` : ''}
        </p>
        <ul className="backup-list" data-testid="backup-list">
          {latestBackups.length === 0 ? (
            <li className="backup-list__empty">还没有备份。点下面的按钮立刻做一份。</li>
          ) : (
            latestBackups.map((item) => (
              <li key={item.date} className="backup-list__item">
                <span className="backup-list__date">{item.date}</span>
                <span className="backup-list__count">{item.files} 个文件</span>
              </li>
            ))
          )}
        </ul>
        <div className="panel__actions">
          <button type="button" className="button" onClick={onBackupNow} disabled={busy} data-testid="backup-now">
            立即备份
          </button>
        </div>
      </section>

      <section className="panel" data-testid="settings-transfer">
        <h2 className="panel__title">导出与恢复</h2>
        <p className="panel__hint">
          导出的文件可以拷到 U 盘或另一台电脑，用「导入」恢复。导入前会自动备份当前数据，不会静默覆盖。
        </p>
        <div className="panel__actions">
          <button type="button" className="button" onClick={onExport} disabled={busy} data-testid="export-all">
            导出全部数据
          </button>
          <button
            type="button"
            className="button"
            onClick={() => onImport('merge')}
            disabled={busy}
            data-testid="import-merge"
          >
            导入（合并）
          </button>
          <button
            type="button"
            className="button"
            onClick={() => onImport('replace')}
            disabled={busy}
            data-testid="import-replace"
          >
            导入（覆盖）
          </button>
        </div>
      </section>

      <section className="panel" data-testid="settings-preferences">
        <h2 className="panel__title">偏好</h2>
        <div className="field-row">
          <label className="field">
            <span className="field__label">每周从周几开始</span>
            <select
              className="field__control"
              value={prefs.weekStart}
              onChange={(event) =>
                void savePrefs({ weekStart: Number.parseInt(event.target.value, 10) as WeekStart })
              }
              data-testid="pref-week-start"
            >
              <option value={1}>周一</option>
              <option value={7}>周日</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">复习间隔</span>
            <select
              className="field__control"
              value={prefs.reviewIntensity}
              onChange={(event) =>
                void savePrefs({ reviewIntensity: event.target.value as ReviewIntensity })
              }
              data-testid="pref-review-intensity"
            >
              <option value="standard">标准</option>
              <option value="relaxed">宽松</option>
              <option value="intense">密集</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">主题</span>
            <select
              className="field__control"
              value={prefs.theme}
              onChange={(event) => void savePrefs({ theme: event.target.value as ThemePreference })}
              data-testid="pref-theme"
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">备份保留份数</span>
            <input
              className="field__control"
              type="number"
              min={1}
              max={365}
              value={prefs.backupKeepDays}
              onChange={(event) => setPrefs({ ...prefs, backupKeepDays: clampKeepDays(event.target.value) })}
              onBlur={(event) => void savePrefs({ backupKeepDays: clampKeepDays(event.target.value) })}
              data-testid="pref-keep-days"
            />
          </label>
        </div>
      </section>

      {/* 快捷键（FEAT-008）：列出全部、可改、可重置、检测冲突 */}
      <HotkeySection bindings={bindings} onChange={onSaveHotkeys} />

      {/* 回收站（FEAT-009） */}
      <TrashSection
        keepDays={prefs.trashKeepDays}
        onChangeKeepDays={(days) => {
          setPrefs({ ...prefs, trashKeepDays: days })
          void savePrefs({ trashKeepDays: days })
        }}
      />

      {/* 操作指南（第 07 块）：该页的独立分区，左侧章节目录 + 右侧正文（自己滚） */}
      <GuideSection />

      <section className="panel panel--danger" data-testid="settings-danger">
        <h2 className="panel__title">危险区</h2>
        <p className="panel__hint">
          清空会删掉全部数据。执行前会自动把当前数据导出到数据目录下的 exports\ 文件夹，
          之后仍可从该文件或 backups 目录恢复。此操作不经过回收站。
        </p>
        <div className="panel__actions">
          <button
            type="button"
            className="button button--danger"
            onClick={() => setClearOpen(true)}
            disabled={busy}
            data-testid="clear-all"
          >
            清空全部数据
          </button>
        </div>
      </section>

      {message ? (
        <p className="notice notice--ok" data-testid="settings-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="notice notice--error" data-testid="settings-error" role="alert">
          出错了：{error}
        </p>
      ) : null}

      <ConfirmDialog
        open={clearOpen}
        title="清空全部数据"
        message="这会删除所有模块的记录。执行前会自动导出一份到桌面，之后可用它恢复。"
        confirmLabel="确认清空"
        confirmText="清空"
        danger
        onConfirm={onClear}
        onCancel={() => setClearOpen(false)}
        testId="clear-dialog"
      />
    </PageShell>
  )
}
