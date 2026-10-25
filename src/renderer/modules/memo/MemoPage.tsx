/**
 * 备忘录模块（DEVPLAN 阶段 4 / PRD §5.6）
 *
 * 一条备忘 = 一段文字，支持多行；组织手段只有**置顶**与**标签**两种，
 * **不做文件夹**（第二轮 FEAT-004 的决定：标签已经够用，多一层目录只会多一套要维护的东西）。
 * 每条可以转成任务或复习卡（第 4/5 阶段分别接上）。
 *
 * ## 富文本（第 04 块）
 *
 * 正文改成 contentEditable 富文本，新记录写 `contentFormat: 'rich'`；
 * 没有这个字段的旧记录仍按纯文本显示与处理（**零改写**）。
 * 因此本页有三处必须抽纯文本，否则 HTML 标签会漏出去：
 * 转任务当标题、转复习卡当正面、复制到剪贴板。
 *
 * ## 标签（第 06 块 FEAT-004）
 *
 * - `tags: string[]` 在 01 块就加好了（形状参考 `Book.tags`），旧记录没有这个字段即没有标签
 * - 工具条上按标签筛选（多选 = 命中任意一个），筛选项由现有标签自动汇总
 * - 「添加标签」走右键 / `⋯` 菜单，抽屉里可增可删
 * - 置顶照旧，且**置顶优先于标签筛选**（筛选只缩范围，不改变置顶在前的顺序）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecordEnvelope } from '../../../shared/types'
import type { ContentFormat } from '../../../shared/richText'
import {
  filterMemosByTags,
  memoPlainText,
  memoToCardInput,
  memoToPlanInput,
  normalizeMemoRecord,
  normalizeMemoText,
  normalizeTags,
  tagCounts,
  type MemoRecord
} from '../../../shared/memo'
import { getDataApi } from '../../lib/dataClient'
import { focusByTestId } from '../../lib/domFocus'
import { useSignal } from '../../lib/useSignal'
import { PageShell } from '../../shell/PageShell'
import { EmptyState } from '../../shell/EmptyState'
import { Drawer, FormDrawer, type FormFormats, type FormValues } from '../../shell/Editors'
import { RichTextComposer } from '../../shell/RichTextComposer'
import { RichTextView } from '../../shell/RichTextView'
import { MenuButton, ContextMenu, useContextMenu } from '../../shell/ContextMenu'
import { memoMenuItems, toSpecs } from '../../../shared/contextMenu'
import type { MenuItemSpec } from '../../../shared/menuItems'
import { copyText } from '../../lib/clipboard'
import { formatShortDate } from '../../../shared/date'
import { dateKey } from '../../../shared/date'

/**
 * 备忘的数据形状**统一用 `shared/memo.ts` 的那一份**（第 06 块起）。
 *
 * 以前这里也声明过一个同名类型，结果是"界面看到的是宽类型、纯逻辑函数收的是严类型"，
 * 每次调用都要断言——两份模型迟早会漂。现在只有一份，页面对外仍按老名字导出，
 * 首页（`HomePage`）不用跟着改。
 */
export type { MemoRecord }

/** 把记录体规范成备忘录；置顶的排在最前，其余按创建时间倒序 */
export function normalizeMemos(records: RecordEnvelope[]): MemoRecord[] {
  const alive = records
    .filter((record) => record.deletedAt === undefined || record.deletedAt === null)
    .map((record) => normalizeMemoRecord(record as unknown as Record<string, unknown>))
    .filter((memo): memo is MemoRecord => memo !== null)
  const pinned = alive.filter((record) => record.pinned === true)
  const rest = alive.filter((record) => record.pinned !== true)
  const byTimeDesc = (a: MemoRecord, b: MemoRecord): number =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  pinned.sort(byTimeDesc)
  rest.sort(byTimeDesc)
  return [...pinned, ...rest]
}

export interface MemoPageProps {
  /** 热键 `N`（当前模块新建一条）：数字变一次 = 把焦点放到"记点什么"输入区 */
  newSignal?: number
}

export function MemoPage({ newSignal }: MemoPageProps = {}): React.JSX.Element {
  const [memos, setMemos] = useState<MemoRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  /** 工具条上选中的标签（空数组 = 不筛） */
  const [activeTags, setActiveTags] = useState<string[]>([])
  /**
   * 菜单（第 03 块）：`⋯` 与右键**共用这一份状态**。
   * 同屏只有一个浮层，所以不会出现"两个菜单互相把对方关掉"。
   */
  const menu = useContextMenu()
  /** 编辑表单：null 表示关闭，否则是正在编辑的那条备忘 */
  const [editId, setEditId] = useState<string | null>(null)
  const [editInitial, setEditInitial] = useState<FormValues>({ text: '' })
  const [editFormats, setEditFormats] = useState<FormFormats>({})
  /** 标签抽屉：null 表示关闭；打开时 draft 是正在编辑的标签集 */
  const [tagTarget, setTagTarget] = useState<MemoRecord | null>(null)
  const [tagDraft, setTagDraft] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')

  const reload = useCallback(async () => {
    try {
      const records = await getDataApi().list('memo')
      setMemos(normalizeMemos(records))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 热键 `N` = 新建备忘（决定 29）：焦点进输入区，与手动点输入框一致 */
  useSignal(newSignal, () => {
    focusByTestId('memo-input')
  })

  const notify = (text: string): void => {
    setFlash(text)
    setTimeout(() => setFlash(null), 2000)
  }

  /**
   * 新建一条备忘。
   *
   * 来自富文本编辑器的正文带 `'rich'` 标记；`format` 缺省时不写这个字段
   * （等价于 plain），与旧记录的口径一致，不给每条备忘都补一个 `'plain'`。
   */
  const addMemo = async (text: string, format?: ContentFormat): Promise<void> => {
    const normalized = normalizeMemoText(text, format)
    await getDataApi().add('memo', {
      text: normalized.text,
      pinned: false,
      ...(normalized.contentFormat ? { contentFormat: normalized.contentFormat } : {})
    })
    await reload()
    notify('已保存')
  }

  const togglePin = async (memo: MemoRecord): Promise<void> => {
    // 以主进程最新记录为准，避免快速点击时用过期的 pinned 值
    const fresh = await getDataApi().list('memo')
    const current = fresh.find((record) => record.id === memo.id) as MemoRecord | undefined
    const nextPinned = !(current?.pinned ?? memo.pinned ?? false)
    await getDataApi().update('memo', memo.id, { pinned: nextPinned })
    await getDataApi().flush()
    await reload()
  }

  const remove = async (id: string): Promise<void> => {
    await getDataApi().remove('memo', id)
    await reload()
  }

  /** 打开编辑表单，带上备忘现有内容（BUG-005：以前写完就锁死，只能删掉重建） */
  const openEdit = (memo: MemoRecord): void => {
    setEditId(memo.id)
    setEditInitial({ text: String(memo.text ?? '') })
    setEditFormats(memo.contentFormat === 'rich' ? { text: 'rich' } : {})
  }

  /** 保存编辑后的内容（富文本按净化后的形状落库） */
  const submitEdit = async (values: FormValues, formats: FormFormats): Promise<void> => {
    if (editId === null) return
    const normalized = normalizeMemoText(values['text'], formats['text'])
    if (normalized.text === '') throw new Error('备忘内容不能为空')
    await getDataApi().update('memo', editId, {
      text: normalized.text,
      ...(normalized.contentFormat ? { contentFormat: normalized.contentFormat } : {})
    })
    await getDataApi().flush()
    await reload()
    notify('已保存')
  }

  /** 转成今天的计划任务（标题只取纯文本，绝不把 HTML 标签当标题） */
  const toPlan = async (memo: MemoRecord): Promise<void> => {
    const input = memoToPlanInput(memo, dateKey(new Date()))
    if (String(input['title']) === '') return
    await getDataApi().add('plan', input)
    await getDataApi().flush()
    notify('已排进今天的计划')
  }

  /** 转成复习卡（正面只取纯文本） */
  const toReview = async (memo: MemoRecord): Promise<void> => {
    const input = memoToCardInput(memo, dateKey(new Date()))
    if (String(input['front']) === '') return
    await getDataApi().add('review', input)
    await getDataApi().flush()
    notify('已生成复习卡')
  }

  /**
   * 复制备忘正文到剪贴板（复制失败要如实说，不能装作成功）。
   * 富文本要先抽纯文本：复制 `<p>第一行</p>` 到别处是没用的东西。
   */
  const copyMemo = async (memo: MemoRecord): Promise<void> => {
    const ok = await copyText(memoPlainText(memo))
    notify(ok ? '已复制到剪贴板' : '复制失败：剪贴板不可用')
  }

  /** 打开标签抽屉：草稿从这条备忘现有的标签起步（可增可删） */
  const openTags = (memo: MemoRecord): void => {
    setTagTarget(memo)
    setTagDraft(normalizeTags(memo.tags))
    setTagInput('')
  }

  /** 保存标签：空数组照存（清空标签是正当操作，不是"没填"） */
  const saveTags = async (): Promise<void> => {
    if (tagTarget === null) return
    const tags = normalizeTags([...tagDraft, tagInput])
    await getDataApi().update('memo', tagTarget.id, { tags })
    await getDataApi().flush()
    await reload()
    setTagTarget(null)
    setTagInput('')
    notify(tags.length === 0 ? '已清空标签' : `已保存 ${tags.length} 个标签`)
  }

  /**
   * 一条备忘的菜单项。
   *
   * **唯一的定义来源**是 `shared/contextMenu.ts` 的 `memoMenuItems`——
   * `⋯` 按钮与右键都调这一个函数，因此两处取到的项必然相同（有单测盯住）。
   */
  const memoItems = useCallback(
    (memo: MemoRecord): MenuItemSpec[] =>
      toSpecs(
        memoMenuItems({
          pinned: memo.pinned === true,
          text: String(memo.text ?? ''),
          onEdit: () => openEdit(memo),
          onDelete: () => void remove(memo.id),
          onTogglePin: () => void togglePin(memo),
          onAddTag: () => openTags(memo),
          onToPlan: () => void toPlan(memo),
          onToReview: () => void toReview(memo),
          onCopy: () => void copyMemo(memo)
        })
      ),
    // 依赖里刻意不放 openEdit / toPlan 这些每次渲染都新建的函数：
    // 它们只捕获当次渲染的 setState（本身稳定），放进依赖会让 memoItems 每帧重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  /** 工具条上的筛选项：现有标签 + 出现次数（多的在前） */
  const tagOptions = useMemo(() => tagCounts(memos), [memos])

  const visible = useMemo(() => {
    const keyword = term.trim()
    // 富文本先抽纯文本再筛：否则用户能搜到 `<p>` 这种标签本身
    const byKeyword =
      keyword === '' ? memos : memos.filter((memo) => memoPlainText(memo).includes(keyword))
    // 标签是"缩小范围"，不是"重新排序"：置顶仍然在前
    return filterMemosByTags(byKeyword, activeTags)
  }, [memos, term, activeTags])

  const toggleTagFilter = (tag: string): void => {
    setActiveTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]
    )
  }

  /** 当前正在编辑的那条备忘（抽屉里显示它的正文，便于确认改的是哪条） */
  const tagTargetText = tagTarget === null ? '' : memoPlainText(tagTarget).slice(0, 60)

  return (
    <PageShell
      title="备忘录"
      description={`${memos.length} 条${
        memos.some((m) => m.pinned) ? ` · ${memos.filter((m) => m.pinned).length} 条置顶` : ''
      }${activeTags.length > 0 ? ` · 筛选 ${visible.length} 条` : ''}`}
      toolbar={
        <>
          <input
            className="toolbar__search"
            placeholder="搜索备忘…"
            value={term}
            data-testid="memo-search"
            onChange={(event) => setTerm(event.target.value)}
          />
          <span className="toolbar__spacer" />
          {/*
            标签筛选（FEAT-004）：只做**标签**，不做文件夹。
            一项都没选 = 看全部；多选 = 命中任意一个（见 shared/memo.ts 的注释）。
          */}
          <div className="tag-filter" data-testid="memo-tag-filter">
            <span className="tag-filter__label">标签</span>
            {tagOptions.length === 0 ? (
              <span className="tag-filter__empty" data-testid="memo-tag-filter-empty">
                还没有标签（右键一条备忘 →「添加标签」）
              </span>
            ) : (
              tagOptions.map((option) => {
                const active = activeTags.includes(option.tag)
                return (
                  <button
                    key={option.tag}
                    type="button"
                    className={`tag-chip${active ? ' tag-chip--active' : ''}`}
                    data-testid="memo-tag-option"
                    data-tag={option.tag}
                    data-active={active ? '1' : '0'}
                    aria-pressed={active}
                    onClick={() => toggleTagFilter(option.tag)}
                  >
                    {option.tag}
                    <span className="tag-chip__count">{option.count}</span>
                  </button>
                )
              })
            )}
            {activeTags.length > 0 ? (
              <button
                type="button"
                className="tag-clear"
                data-testid="memo-tag-clear"
                onClick={() => setActiveTags([])}
              >
                清除筛选
              </button>
            ) : null}
          </div>
        </>
      }
    >
      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}
      {flash ? (
        <p className="notice notice--ok" data-testid="memo-flash">
          {flash}
        </p>
      ) : null}

      {/*
        新建备忘：正文用富文本编辑器（第 04 块）。
        Ctrl+回车保存；保存失败时输入**原样保留**，不会丢用户写的东西。
      */}
      <RichTextComposer
        testId="memo-input"
        placeholder="记点什么…（可以写多行；Ctrl+回车保存）"
        submitKey="ctrl-enter"
        minHeight={96}
        onSubmit={addMemo}
      />

      {visible.length === 0 ? (
        <EmptyState
          message={
            term.trim() !== '' || activeTags.length > 0
              ? '没有匹配的备忘。'
              : '还没有备忘。上面写一条试试。'
          }
          testId="memo-empty"
        />
      ) : (
        <ul className="memo-list" data-testid="memo-list">
          {visible.map((memo) => (
            <li
              key={memo.id}
              className={`memo${memo.pinned ? ' memo--pinned' : ''}`}
              data-testid="memo-item"
              data-memo-id={memo.id}
              data-pinned={memo.pinned === true ? '1' : '0'}
              data-tags={(memo.tags ?? []).join(',')}
              onContextMenu={(event) =>
                menu.openFromEvent(event, memoItems(memo), `memo-item:${memo.id}`)
              }
            >
              <div className="memo__body">
                {/* 按 contentFormat 渲染：旧记录没有这个字段 → 走纯文本，显示与以前一致 */}
                <RichTextView
                  value={String(memo.text ?? '')}
                  format={memo.contentFormat}
                  className="memo__text"
                  testId="memo-text"
                />
                <div className="memo__meta">
                  {(memo.tags ?? []).length > 0 ? (
                    <span className="memo__tags" data-testid="memo-tags">
                      {(memo.tags ?? []).map((tag) => (
                        <span key={tag} className="tag-chip tag-chip--small" data-tag={tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="memo__time">{formatShortDate(String(memo.createdAt).slice(0, 10))}</span>
                </div>
              </div>

              <div className="memo__actions">
                <button
                  type="button"
                  className={`memo__pin${memo.pinned ? ' is-active' : ''}`}
                  aria-label={memo.pinned ? '取消置顶' : '置顶'}
                  data-testid="memo-pin"
                  onClick={() => void togglePin(memo)}
                >
                  📌
                </button>
                {/* `⋯` 与右键取到的是同一批菜单项（同一个 memoItems） */}
                <MenuButton
                  menu={menu}
                  items={() => memoItems(memo)}
                  testId="memo-menu"
                  className="memo__menu-button"
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 编辑备忘（BUG-005）：正文同样是富文本（第 04 块） */}
      <FormDrawer
        open={editId !== null}
        title="编辑备忘"
        fields={[
          {
            kind: 'rich',
            key: 'text',
            label: '内容',
            placeholder: '记点什么…',
            required: true,
            testId: 'memo-edit-text'
          }
        ]}
        initialValues={editInitial}
        initialFormats={editFormats}
        onClose={() => setEditId(null)}
        onSubmit={submitEdit}
        testId="memo-edit-form"
      />

      {/*
        标签抽屉（FEAT-004）：第 03 块只接了菜单项，这里把功能补上。
        可增可删：点已有标签 = 加上/去掉；输入框里敲新的 + 「加这个标签」。
      */}
      <Drawer
        open={tagTarget !== null}
        title="添加标签"
        onClose={() => {
          setTagTarget(null)
          setTagInput('')
        }}
        testId="memo-tag-drawer"
        footer={
          <>
            <button
              type="button"
              className="button"
              data-testid="memo-tag-close"
              onClick={() => {
                setTagTarget(null)
                setTagInput('')
              }}
            >
              取消
            </button>
            <span className="toolbar__spacer" />
            <button
              type="button"
              className="button button--primary"
              data-testid="memo-tag-save"
              onClick={() => void saveTags()}
            >
              保存标签
            </button>
          </>
        }
      >
        <p className="panel__hint" data-testid="memo-tag-notice">
          这一条备忘：{tagTargetText === '' ? '（空）' : tagTargetText}
        </p>
        <p className="panel__hint">点一下已有标签就是加上或去掉；只做标签，不做文件夹。</p>

        <div className="tag-editor" data-testid="memo-tag-chips">
          {tagOptions.length === 0 ? (
            <span className="panel__hint" data-testid="memo-tag-editor-empty">
              还没有任何标签，在下面输入第一个。
            </span>
          ) : (
            tagOptions.map((option) => {
              const selected = tagDraft.includes(option.tag)
              return (
                <button
                  key={option.tag}
                  type="button"
                  className={`tag-chip${selected ? ' tag-chip--active' : ''}`}
                  data-testid="memo-tag-toggle"
                  data-tag={option.tag}
                  data-selected={selected ? '1' : '0'}
                  aria-pressed={selected}
                  onClick={() =>
                    setTagDraft((current) =>
                      current.includes(option.tag)
                        ? current.filter((item) => item !== option.tag)
                        : [...current, option.tag]
                    )
                  }
                >
                  {option.tag}
                </button>
              )
            })
          )}
        </div>

        <label className="field">
          <span className="field__label">新标签</span>
          <input
            className="field__control"
            placeholder="例如：工作 / 待办 / 灵感"
            value={tagInput}
            data-testid="memo-tag-input"
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              const next = normalizeTags([...tagDraft, tagInput])
              setTagDraft(next)
              setTagInput('')
            }}
          />
          <span className="field__hint">回车可以先加进草稿，最后点「保存标签」落库</span>
        </label>
        <p className="panel__hint" data-testid="memo-tag-draft">
          正在编辑的标签：{tagDraft.length === 0 ? '（无）' : tagDraft.join('、')}
        </p>
      </Drawer>

      {/* 全页只放一个菜单实例：`⋯` 与右键都往它里面塞同一批菜单项 */}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </PageShell>
  )
}
