/**
 * 全局搜索抽屉（DEVPLAN 阶段 6 / PRD §2.6 与 §10.10 J1–J3）
 *
 * Ctrl+K 打开；结果按模块分组（计划 / 备忘 / 学习 / 复习 / 读书）；
 * 点一条跳到对应模块。读书与学习始终是两个独立分组，不合并。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  searchAll,
  summarizeGroups,
  totalHits,
  type SearchGroup,
  type SearchModule
} from '../../shared/search'
import { getDataApi } from '../lib/dataClient'
import { EmptyState } from './EmptyState'
import { Drawer } from './Editors'

/** 分组 → 导航项 id（复习的卡片在复习页，读书的摘录在读书页） */
const GROUP_TO_VIEW: Record<SearchModule, string> = {
  plan: 'plan',
  memo: 'memo',
  learning: 'learning',
  review: 'review',
  reading: 'reading'
}

export interface SearchDrawerProps {
  open: boolean
  onClose: () => void
  onNavigate: (viewId: string) => void
  /** 从首页/侧边栏传进来的初始关键词 */
  initialTerm?: string
}

export function SearchDrawer({
  open,
  onClose,
  onNavigate,
  initialTerm = ''
}: SearchDrawerProps): React.JSX.Element {
  const [term, setTerm] = useState(initialTerm)
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  /** 打开时聚焦输入框 */
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  /** 关键词变化时重新搜索：每次都从主进程取最新数据，保证搜到刚写的内容 */
  const runSearch = useCallback(async (keyword: string) => {
    if (keyword.trim() === '') {
      setGroups([])
      return
    }
    setLoading(true)
    try {
      const [plan, memo, learning, review, reading] = await Promise.all([
        getDataApi().list('plan'),
        getDataApi().list('memo'),
        getDataApi().list('learning'),
        getDataApi().list('review'),
        getDataApi().list('reading')
      ])
      setGroups(
        searchAll(
          {
            plan: plan as unknown as Array<Record<string, unknown>>,
            memo: memo as unknown as Array<Record<string, unknown>>,
            learning: learning as unknown as Array<Record<string, unknown>>,
            review: review as unknown as Array<Record<string, unknown>>,
            reading: reading as unknown as Array<Record<string, unknown>>
          },
          keyword
        )
      )
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      void runSearch(term)
    }, 120)
    return () => clearTimeout(timer)
  }, [open, term, runSearch])

  // 每次打开都清空上一次的关键词，避免残留让人误解
  useEffect(() => {
    if (!open) setTerm(initialTerm)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const total = useMemo(() => totalHits(groups), [groups])
  const summary = useMemo(() => summarizeGroups(groups), [groups])

  return (
    <Drawer
      open={open}
      title="搜索（Ctrl+K）"
      onClose={onClose}
      testId="search-drawer"
    >
      <input
        ref={inputRef}
        className="search__input"
        placeholder="搜索计划、备忘、学习、复习、读书…"
        value={term}
        data-testid="search-input"
        onChange={(event) => setTerm(event.target.value)}
      />

      <p className="search__summary" data-testid="search-summary">
        {term.trim() === '' ? '输入关键词开始搜索' : loading ? '搜索中…' : summary}
      </p>

      {error ? <p className="notice notice--error">搜索失败：{error}</p> : null}

      {term.trim() !== '' && total === 0 && !loading ? (
        <EmptyState message="没有找到匹配的内容。" testId="search-empty" />
      ) : null}

      <div className="search__results" data-testid="search-results">
        {groups.map((group) => (
          <section
            key={group.module}
            className="search__group"
            data-testid={`search-group-${group.module}`}
            data-count={group.hits.length}
          >
            <h3 className="search__group-title">
              {group.label}
              <span className="search__group-count">{group.hits.length}</span>
            </h3>
            <ul className="search__list">
              {group.hits.map((hit) => (
                <li key={`${group.module}-${hit.id}`}>
                  <button
                    type="button"
                    className="search__hit"
                    data-testid="search-hit"
                    data-module={group.module}
                    data-record-id={hit.id}
                    onClick={() => {
                      onNavigate(GROUP_TO_VIEW[group.module])
                      onClose()
                    }}
                  >
                    <span className="search__hit-title">{hit.title}</span>
                    <span className="search__hit-meta">{hit.meta}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Drawer>
  )
}
