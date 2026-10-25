/**
 * 回收站（第二轮 FEAT-009）
 *
 * 放在「数据与设置」里。
 *
 * 它是什么（用户已确认）：**只针对单个条目**——某个学习主题、某本书、某条备忘不要了，
 * 先扔进回收站以防万一，需要时能原样恢复。
 * **"清空全部数据"不属于回收站**，那是物理删除（唯一例外）。
 *
 * 实现上不新增数据文件：删除只是打一个 deletedAt 标记，记录仍在原模块文件里。
 * 所以"恢复"就是清掉标记，天然回到原位置，不会出现两份数据不一致。
 */
import { useCallback, useEffect, useState } from 'react'
import { getTrashApi, type TrashEntryData } from '../../lib/dataClient'
import { DATA_CHANGED_EVENT, notifyDataChanged } from '../../lib/dataEvents'
import { EmptyState } from '../../shell/EmptyState'
import { ConfirmDialog } from '../../shell/Editors'
import { clampTrashKeepDays } from '../../../shared/preferences'
import {
  TRASH_KEEP_DAYS_OPTIONS,
  TRASH_KEEP_FOREVER_DAYS,
  emptyTrashHint,
  keepDaysLabel
} from '../../../shared/trash'

export interface TrashSectionProps {
  /** 当前保留期限（天） */
  keepDays: number
  /** 用户改了保留期限 */
  onChangeKeepDays: (days: number) => void
}

/** 删除时间显示成"月-日 时:分"，回收站里不需要精确到秒 */
function formatDeletedAt(value: string): string {
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  const date = new Date(at)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function TrashSection({ keepDays, onChangeKeepDays }: TrashSectionProps): React.JSX.Element {
  const [entries, setEntries] = useState<TrashEntryData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [emptyOpen, setEmptyOpen] = useState(false)
  const [purgeOne, setPurgeOne] = useState<TrashEntryData | null>(null)

  const reload = useCallback(async () => {
    try {
      setEntries(await getTrashApi().list())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 别的页面删了东西（或者恢复/彻底删除后）要刷新回收站列表。
   * 不监听的话：用户先打开设置页、再去别处删一条、回到设置页看到的还是旧列表。
   * 这也让自动验收能用"界面路径删除 + 界面路径查看"来验证，而不必绕过界面。
   */
  useEffect(() => {
    const handler = (): void => {
      void reload()
    }
    window.addEventListener(DATA_CHANGED_EVENT, handler)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, handler)
  }, [reload])

  const notify = (text: string): void => {
    setFlash(text)
    setTimeout(() => setFlash(null), 2600)
  }

  const restore = async (entry: TrashEntryData): Promise<void> => {
    setBusy(true)
    try {
      const ok = await getTrashApi().restore(entry.module, entry.id)
      await reload()
      // 恢复后别的页面要重新取数，否则切换过去还是旧列表
      notifyDataChanged(entry.module)
      notify(ok ? `已恢复「${entry.title}」` : '这条记录已经不存在了')
    } finally {
      setBusy(false)
    }
  }

  const purge = async (entry: TrashEntryData): Promise<void> => {
    setBusy(true)
    try {
      await getTrashApi().purge(entry.module, entry.id)
      await reload()
      setPurgeOne(null)
      notify('已彻底删除')
    } finally {
      setBusy(false)
    }
  }

  const purgeAll = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await getTrashApi().purgeAll()
      await reload()
      setEmptyOpen(false)
      notify(result.message)
    } finally {
      setBusy(false)
    }
  }

  const purgeExpired = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await getTrashApi().purgeExpired(keepDays)
      await reload()
      notify(result.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" data-testid="trash-section">
      <h3 className="panel__title">回收站（{entries.length}）</h3>
      <p className="panel__hint">
        删除的内容会先放到这里，可以从这里恢复；确认不需要了再彻底删除。
        「清空全部数据」不经过回收站，它是直接抹掉。
      </p>

      {error ? <p className="notice notice--error">读取回收站失败：{error}</p> : null}
      {flash ? (
        <p className="notice notice--ok" data-testid="trash-flash">
          {flash}
        </p>
      ) : null}

      {/* 保留期限：7 天 / 30 天 / 永久保留 / 自定义 */}
      <label className="field" htmlFor="trash-keep-days">
        <span className="field__label">自动清理</span>
        <select
          id="trash-keep-days"
          className="field__control"
          value={String(keepDays)}
          data-testid="trash-keep-days"
          onChange={(event) => onChangeKeepDays(clampTrashKeepDays(event.target.value))}
        >
          {TRASH_KEEP_DAYS_OPTIONS.filter((days) => days !== TRASH_KEEP_FOREVER_DAYS).map((days) => (
            <option key={days} value={String(days)}>
              {keepDaysLabel(days)}
            </option>
          ))}
          <option value={String(TRASH_KEEP_FOREVER_DAYS)}>永久保留</option>
        </select>
        <span className="field__hint">
          超过这个期限的内容会在下次启动程序时被彻底删除（当前：{keepDaysLabel(keepDays)}）
        </span>
      </label>

      <div className="detail__actions">
        <button
          type="button"
          className="button"
          disabled={busy || entries.length === 0}
          data-testid="trash-purge-expired"
          onClick={() => void purgeExpired()}
        >
          立即清理过期内容
        </button>
        <button
          type="button"
          className="button is-danger"
          disabled={busy || entries.length === 0}
          data-testid="trash-empty"
          onClick={() => setEmptyOpen(true)}
        >
          清空回收站
        </button>
      </div>

      {entries.length === 0 ? (
        <EmptyState message={emptyTrashHint()} testId="trash-empty-state" />
      ) : (
        <ul className="trash-list" data-testid="trash-list">
          {entries.map((entry) => (
            <li
              key={`${entry.module}-${entry.id}`}
              className="trash-item"
              data-testid="trash-item"
              data-module={entry.module}
              data-record-id={entry.id}
            >
              <div className="trash-item__body">
                <span className="trash-item__title">{entry.title}</span>
                <span className="trash-item__meta">
                  <span className="trash-item__type">{entry.typeLabel}</span>
                  <span>· {entry.origin}</span>
                  <span>· 删除于 {formatDeletedAt(entry.deletedAt)}</span>
                </span>
              </div>
              <div className="trash-item__actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  data-testid="trash-restore"
                  onClick={() => void restore(entry)}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="button is-danger"
                  disabled={busy}
                  data-testid="trash-purge"
                  onClick={() => setPurgeOne(entry)}
                >
                  彻底删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 彻底删除一条：不可撤销，必须确认 */}
      <ConfirmDialog
        open={purgeOne !== null}
        title="彻底删除这一项？"
        message={
          <>
            <p>
              将永久删除「{purgeOne?.title ?? ''}」（{purgeOne?.typeLabel ?? ''}）。
            </p>
            <p>此操作无法撤销，也不能再从回收站恢复。</p>
          </>
        }
        confirmLabel="彻底删除"
        danger
        onConfirm={() => {
          if (purgeOne) void purge(purgeOne)
        }}
        onCancel={() => setPurgeOne(null)}
        testId="trash-purge-dialog"
      />

      {/* 清空回收站 */}
      <ConfirmDialog
        open={emptyOpen}
        title="清空回收站？"
        message={
          <>
            <p>将永久删除回收站里的全部 {entries.length} 项内容。</p>
            <p>此操作无法撤销。回收站之外的数据不受影响。</p>
          </>
        }
        confirmLabel="清空"
        danger
        onConfirm={() => void purgeAll()}
        onCancel={() => setEmptyOpen(false)}
        testId="trash-empty-dialog"
      />
    </section>
  )
}
