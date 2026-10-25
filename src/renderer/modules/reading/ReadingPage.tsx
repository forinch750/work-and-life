/**
 * 读书页（DEVPLAN 阶段 6 / PRD §5.5；**第 11 块按定稿重做界面**）
 *
 * ## 布局（`MASTER.md` §7.7 那张图，照做的）
 *
 * ```
 * ┌ 左栏（永不动） ┬ 上：预览（信息卡 + 进度条 + 按钮排）           ┐
 * │ 书架（封面块）  │ ────────────────────────────────────────── │
 * │ 深 在读·43%     │ 中：摘录与想法 卡 | 阅读记录 卡（固定高，各自滚）│
 * │ 语 在读·13% ↕滚 │ ────────────────────────────────────────── │
 * │ 人 读完·100%    │ 下：章节树（书为根 → 章 → 子章；摘录不在这里）  │
 * │ ────────────    │                                             │
 * │ 数据与设置      │                                             │
 * └─────────────────┴─────────────────────────────────────────────┘
 * ```
 *
 * **三步走**（决定 1 / §6.7）：选中书 → 看预览（含中区两块）→ 点「进入书」→
 * **下方**展开章节树。预览与卡片**留在上面，不整页替换**，所以三段是同一个布局的三行，
 * 不是三个页面（骨架见 `shell/ModuleBands.tsx`）。
 *
 * ## 本块只重做界面，不重写逻辑
 *
 * - **书内进度 = 读完的章 / 总章数**（决定 23）：页面里没有一行公式，
 *   全部走 `shared/treeProgress.ts` 的公共实现（经 `shared/readingPageView.ts` 转调）。
 *   **页码只作"读到哪了"的参考显示，不参与进度计算**——有单测 + 端到端各钉一条。
 * - **摘录与想法不进树**（决定 24）：它们永远不打勾，当叶子算会让进度永远偏低（已实测踩过）。
 *   页面里只有一个落点：树只喂 `data.nodes`（`kind: 'node'`），摘录永远只在**中区那块列表**里。
 * - 树的增删改 / 拖拽 / 右键菜单 / 打勾：`shell/TreeView.tsx`（第 02 块）原样复用。
 * - 数据读写：仍走 `window.api.data` 那套（`getDataApi()`），没有新出口。
 *
 * ## 与旧版的差别（用户看得见的那几条）
 *
 * - 书架从"整页三组卡片 + 右侧抽屉"改成**左栏书架**（封面块 + 书名首字 + 进度细线）。
 * - 书的详情从抽屉搬进**上预览**，预览与中区两块永远在，树折叠在下面（三步走）。
 * - 「更新进度」并进「记一次阅读」：填页码（电子书填百分比）+ 时长，一次记一条。
 * - 章节行就地展开：**该章的阅读记录**（挂在章上，第 11 块新增的可选 `nodeId`）+
 *   记一次阅读 / 加子章 / 重命名 / 标记读完 / 删除。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { dateKey } from '../../../shared/date'
import {
  applyProgressUpdate,
  coverHue,
  excerptToCard,
  finishPatch,
  normalizeReadingRecord,
  type Book,
  type BookFormat,
  type Excerpt,
  type ReadingNode,
  type ReadingProgress,
  type ReadingStatus
} from '../../../shared/reading'
import {
  bookPreviewFacts,
  chapterProgressText,
  chapterRowProgress,
  chapterStats,
  excerptCounts,
  excerptTypeLabel,
  excerptsOfBook,
  isBookEntered,
  readingTreeNodes,
  recordOwnerText,
  recordPagesText,
  recordsOfBook,
  recordsOfChapter,
  shelfCoverInitial,
  shelfMetaText,
  shelfRows,
  spotNote,
  statusLabel
} from '../../../shared/readingPageView'
import { subtreeIds, buildMovePatches, canMove } from '../../../shared/treeMove'
import { getDataApi } from '../../lib/dataClient'
import { notifyDataChanged } from '../../lib/dataEvents'
import { usePanelEscape } from '../../lib/usePanelEscape'
import { useSignal } from '../../lib/useSignal'
import { unlinkBook, unlinkTreeNode } from '../../../shared/unlink'
import {
  EMPTY_NODE_PANEL_STATE,
  closeOpenPanel,
  isExpanded,
  openDetailIdsOf,
  setExpanded,
  toggleOpenPanel,
  type NodePanelState
} from '../../../shared/nodePanel'
import { PageShell } from '../../shell/PageShell'
import { EmptyState } from '../../shell/EmptyState'
import { ConfirmDialog, Drawer, FormDrawer, type FormFormats, type FormValues } from '../../shell/Editors'
import { BandCard, ModuleBands } from '../../shell/ModuleBands'
import { SidebarListPortal } from '../../shell/SidebarSlot'
import { RichTextComposer, SaveHint } from '../../shell/RichTextComposer'
import { RichTextView } from '../../shell/RichTextView'
import { RichText } from '../../shell/RichText'
import { normalizeRichText, type ContentFormat } from '../../../shared/richText'
import { useSaveState } from '../../lib/saveState'
import { TreeView, type TreeMenuActions, type TreeViewItem } from '../../shell/TreeView'
import { MenuButton, ContextMenu, useContextMenu } from '../../shell/ContextMenu'
import { bookMenuItems, toSpecs, treeNodeMenuFromActions } from '../../../shared/contextMenu'
import type { MenuItemSpec } from '../../../shared/menuItems'
import { useTreeDebug } from '../../shell/treeDebug'

interface ReadingData {
  books: Book[]
  progress: ReadingProgress[]
  excerpts: Excerpt[]
  /** 章节树：每本书各自的节点，`ownerId` = 书 id */
  nodes: ReadingNode[]
}

const EMPTY: ReadingData = { books: [], progress: [], excerpts: [], nodes: [] }

/** 「记一次阅读」抽屉里的时长预设 */
const MINUTE_PRESETS = [15, 30, 45, 60]

/** 从记录里拆出各类数据（导出供测试） */
export function splitReading(records: Array<Record<string, unknown>>): ReadingData {
  const result: ReadingData = { books: [], progress: [], excerpts: [], nodes: [] }
  for (const record of records) {
    if (record['deletedAt'] !== undefined && record['deletedAt'] !== null) continue
    const normalized = normalizeReadingRecord(record)
    if (!normalized) continue
    if (normalized.kind === 'book' && normalized.title !== '') result.books.push(normalized)
    else if (normalized.kind === 'progress') result.progress.push(normalized)
    else if (normalized.kind === 'excerpt' && normalized.content !== '') result.excerpts.push(normalized)
  }
  // 树的节点**只认 kind: 'node'**（决定 24：摘录与想法永远进不来）——
  // 判据收在 `readingTreeNodes()` 一处，有单测钉着。
  result.nodes = readingTreeNodes(records)
  return result
}

export interface ReadingPageProps {
  /** 热键 `N`（当前模块新建一条）：数字变一次 = 打开"添加书"表单 */
  newSignal?: number
}

export function ReadingPage({ newSignal }: ReadingPageProps = {}): React.JSX.Element {
  const [data, setData] = useState<ReadingData>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * 三步走的第二步（决定 1 / §6.7）：**已经「进入」的那本书 id**。
   *
   * 「进入书」不是路由、也不是整页替换——它只决定**下方章节树那一段显不显示**。
   * 状态就是一个 id：`entered === selected` 时树展开；换一本书自动回到"未进入"。
   * 与学习页 / 复习页是同一个判据（`readingPageView.isBookEntered` 转调 `isTopicEntered`）。
   */
  const [enteredBookId, setEnteredBookId] = useState<string | null>(null)

  // 表单：添加书
  const [bookDrawerOpen, setBookDrawerOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAuthor, setNewAuthor] = useState('')
  const [newFormat, setNewFormat] = useState<BookFormat>('paper')
  const [newTotalPages, setNewTotalPages] = useState('')

  // 表单：记一次阅读（页码 / 时长）
  const [logOpen, setLogOpen] = useState(false)
  /** 这一次是从哪一章记的（null = 书级记录，不写 nodeId） */
  const [logNodeId, setLogNodeId] = useState<string | null>(null)
  const [progressValue, setProgressValue] = useState('')
  const [progressMinutes, setProgressMinutes] = useState('30')

  // 表单：加摘录
  const [excerptOpen, setExcerptOpen] = useState(false)
  const [excerptLocator, setExcerptLocator] = useState('')
  const [excerptType, setExcerptType] = useState<'quote' | 'thought'>('quote')

  // 表单：编辑书 / 标记读完 / 删除
  const [editOpen, setEditOpen] = useState(false)
  const [editInitial, setEditInitial] = useState<FormValues>({})
  const [editFormats, setEditFormats] = useState<FormFormats>({})
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishRating, setFinishRating] = useState(5)
  /** 总评改成富文本（第 04 块）：草稿带格式标记，保存失败时保留 */
  const [finishReview, setFinishReview] = useState<{ text: string; format: ContentFormat }>({
    text: '',
    format: 'rich'
  })
  const finishSave = useSaveState()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteSummary, setDeleteSummary] = useState('')

  // 章节树（第 02 块）：新增 / 就地改名 / 改页码说明 / 删除 / 展开
  const [chapterParent, setChapterParent] = useState<ReadingNode | null>(null)
  const [chapterDrawerOpen, setChapterDrawerOpen] = useState(false)
  const [chapterDraft, setChapterDraft] = useState('')
  const [chapterDelete, setChapterDelete] = useState<ReadingNode | null>(null)
  /** 面板里的「重命名」（与行内输入框是两条路，写的是同一个字段） */
  const [chapterRename, setChapterRename] = useState<{ id: string; value: string } | null>(null)
  /** 「改页码 / 进度说明」抽屉：改的是节点的 `note` */
  const [noteEdit, setNoteEdit] = useState<ReadingNode | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /**
   * 树行的两层展开状态（2026-10 修订）：**子节点展开** vs **就地面板**。
   *
   * 与学习页是同一套（`shared/nodePanel.ts` + `usePanelEscape`）：
   * 两页的收起入口、`Esc`、点行语义完全一致（§6.4 第 6 条）。
   *   - `expandedIds`   数组：祖先链要能同时展开（改成单值是踩过的坑）
   *   - `openPanelId`   单值：同屏只开一个面板
   */
  const [nodeUi, setNodeUi] = useState<NodePanelState>(EMPTY_NODE_PANEL_STATE)

  /**
   * 菜单（第 03 块）：书的 `⋯` 与章节行的右键共用**这一份状态**，
   * 因此同屏永远只有一个浮层（两个实例会各自监听"点别处关闭"而互相打架）。
   */
  const menu = useContextMenu()
  const [pendingMenu, setPendingMenu] = useState<{
    point: { x: number; y: number }
    items: MenuItemSpec[]
    source: string
  } | null>(null)

  useEffect(() => {
    if (pendingMenu === null) return
    menu.openAtPoint(pendingMenu.point, pendingMenu.items, pendingMenu.source)
    setPendingMenu(null)
  }, [pendingMenu, menu])

  /** `Esc` 收起章节面板（与学习页同一个 hook，所以两页行为一致） */
  usePanelEscape(nodeUi.openPanelId !== null, () =>
    setNodeUi((current) => closeOpenPanel(current))
  )

  /**
   * 热键 `N` = 添加书籍（决定 29）。与页头「添加书」按钮同一个动作：
   * 打开同一个表单抽屉，日期/状态等默认值与手动点按钮完全一致。
   */
  useSignal(newSignal, () => setBookDrawerOpen(true))

  const reload = useCallback(async () => {
    try {
      const records = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
      setData(splitReading(records))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const handler = (): void => {
      void reload()
    }
    window.addEventListener('worklife:data-changed', handler)
    return () => window.removeEventListener('worklife:data-changed', handler)
  }, [reload])

  const notify = (text: string): void => {
    setFlash(text)
    setTimeout(() => setFlash(null), 2200)
  }

  const afterWrite = async (): Promise<void> => {
    await getDataApi().flush()
    await reload()
    notifyDataChanged('reading')
  }

  // ---------------------------------------------------------------------
  // 派生数据：书架 / 当前这本书的树、记录、摘录
  // ---------------------------------------------------------------------

  /** 每本书的章节树：左栏每一行都要算它自己的进度（不只是选中的那本） */
  const nodesByBook = useMemo(() => {
    const map = new Map<string, ReadingNode[]>()
    for (const node of data.nodes) {
      const list = map.get(node.ownerId) ?? []
      list.push(node)
      map.set(node.ownerId, list)
    }
    return map
  }, [data.nodes])

  const nodesOf = (bookId: string): ReadingNode[] => nodesByBook.get(bookId) ?? []

  const visibleBooks = useMemo(() => {
    const keyword = term.trim()
    const list =
      keyword === ''
        ? data.books
        : data.books.filter((book) => book.title.includes(keyword) || book.author.includes(keyword))
    // 三档顺序：在读 → 想读 → 读完（组内最近更新倒序），与 §7.7 的左栏一致
    return shelfRows(list)
  }, [data.books, term])

  const selected = data.books.find((book) => book.id === selectedId) ?? null
  /** 三步走：进入过这本书没有 */
  const entered = isBookEntered(enteredBookId, selected?.id ?? null)
  /** 这本书的章节树（摘录永远不在这里——见文件头） */
  const bookNodes = useMemo(
    () => (selected === null ? [] : nodesByBook.get(selected.id) ?? []),
    [selected, nodesByBook]
  )
  /** 书内完成度：读完的章 / 总章数（只数最小单元，页码只作参考） */
  const stats = chapterStats(bookNodes)
  const bookRecords = selected ? recordsOfBook(data.progress, selected.id) : []
  const bookExcerpts = selected ? excerptsOfBook(data.excerpts, selected.id) : []
  const facts = selected
    ? bookPreviewFacts(selected, bookNodes, bookRecords, bookExcerpts)
    : null
  const counts = excerptCounts(bookExcerpts)
  const spot = spotNote(bookRecords)
  /** 这一次「记一次阅读」挂在哪个节点上（书级 → null） */
  const logNode = logNodeId === null ? null : bookNodes.find((node) => node.id === logNodeId) ?? null

  // 验收用：把父子映射写到 window 上。
  // 树行在 DOM 里只有 depth，还原不出 parentId；而验收要"沿祖先链逐级展开"
  // 才能看到深层章节（界面是手风琴式的）。学习页有一份同样的挂点，两处口径一致。
  useEffect(() => {
    const host = window as unknown as { __treeParentMap?: Record<string, string | null> }
    host.__treeParentMap = Object.fromEntries(bookNodes.map((node) => [node.id, node.parentId]))
  }, [bookNodes])

  const selectBook = (book: Book): void => {
    setSelectedId(book.id)
    // 换一本书 = 回到"未进入"那一步（同一本书再点一次不动）
    setEnteredBookId((current) => (current === book.id ? current : null))
    setChapterRename(null)
  }

  // ---------------------------------------------------------------------
  // 书：增 / 改 / 删 / 读完
  // ---------------------------------------------------------------------

  const addBook = async (): Promise<void> => {
    const title = newTitle.trim()
    if (title === '') return
    await getDataApi().add('reading', {
      kind: 'book',
      title,
      author: newAuthor.trim(),
      format: newFormat,
      status: 'want',
      totalPages: newFormat === 'paper' ? Number.parseInt(newTotalPages || '0', 10) || 0 : 0,
      currentPage: 0,
      percent: 0,
      finishedAt: null,
      rating: 0,
      review: ''
    })
    setNewTitle('')
    setNewAuthor('')
    setNewTotalPages('')
    setBookDrawerOpen(false)
    await afterWrite()
    notify('已加入书架')
  }

  /** 打开编辑书的表单，带上现有值（BUG-002） */
  const openEditBook = (): void => {
    if (!selected) return
    setEditInitial({
      title: selected.title,
      author: selected.author,
      format: selected.format,
      totalPages: String(selected.totalPages),
      status: selected.status,
      rating: String(selected.rating),
      review: selected.review
    })
    // 总评的格式标记也是书的一部分：没有这个字段的旧书按 plain 处理（零改写）
    setEditFormats(selected.contentFormat === 'rich' ? { review: 'rich' } : {})
    setEditOpen(true)
  }

  /** 保存书的信息（总评是富文本：按净化后的形状落库） */
  const onSaveBookEdit = async (values: FormValues, formats: FormFormats): Promise<void> => {
    if (!selected) throw new Error('没有选中的书')
    const format = (values['format'] === 'ebook' ? 'ebook' : 'paper') as BookFormat
    const rating = Math.max(1, Math.min(5, Number.parseInt(values['rating'] || '0', 10) || 0))
    const review = normalizeRichText(values['review'], formats['review'])
    await getDataApi().update('reading', selected.id, {
      title: (values['title'] ?? '').trim(),
      author: (values['author'] ?? '').trim(),
      format,
      // 电子书的总页数没有意义，统一归零，避免两个字段互相污染
      totalPages: format === 'paper' ? Number.parseInt(values['totalPages'] || '0', 10) || 0 : 0,
      status: (values['status'] ?? 'want') as ReadingStatus,
      rating,
      review: review.text,
      ...(review.contentFormat ? { contentFormat: review.contentFormat } : {})
    })
    await afterWrite()
    notify('已保存')
  }

  /** 删除前先算清影响范围（BUG-007：说明关联内容会被保留） */
  const prepareDeleteBook = async (): Promise<void> => {
    if (!selected) return
    const records = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
    const { summary } = unlinkBook(selected.id, records)
    setDeleteSummary(summary)
    setDeleteOpen(true)
  }

  const confirmDeleteBook = async (): Promise<void> => {
    if (!selected) return
    const id = selected.id
    const records = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
    const { patches } = unlinkBook(id, records)
    // 先解除关联，再删本体：反过来的话中途失败会留下悬空章节
    for (const patch of patches) {
      await getDataApi().update(patch.module, patch.id, patch.patch)
    }
    await getDataApi().remove('reading', id)
    setSelectedId(null)
    setEnteredBookId(null)
    setDeleteOpen(false)
    await afterWrite()
    notify('已删除，可在「数据与设置 → 回收站」里恢复')
  }

  /** 标记在读 / 标记读完（状态只由按钮改，树上的勾不参与——决定 30 同理） */
  const markStatus = async (status: ReadingStatus): Promise<void> => {
    if (!selected) return
    await getDataApi().update('reading', selected.id, {
      status,
      ...(status === 'finished'
        ? { finishedAt: dateKey(new Date()) }
        : { finishedAt: null })
    })
    await afterWrite()
    notify(status === 'finished' ? '已标记读完' : '已标记在读')
  }

  // ---------------------------------------------------------------------
  // 记一次阅读（页码只作参考：进度按章节算）
  // ---------------------------------------------------------------------

  /** 打开「记一次阅读」；`nodeId` 非空 = 这一条挂在某章上 */
  const openLog = (nodeId: string | null): void => {
    setLogNodeId(nodeId)
    setProgressValue('')
    setLogOpen(true)
  }

  const saveLog = async (): Promise<void> => {
    if (!selected) return
    const raw = Number.parseInt(progressValue || '0', 10) || 0
    // 页码 / 百分比只是"读到哪了"的参考：进度条与左栏细线都不看它（决定 23）
    const patch =
      selected.format === 'paper'
        ? applyProgressUpdate(selected, { page: raw })
        : applyProgressUpdate(selected, { percent: raw })
    await getDataApi().update('reading', selected.id, patch as Record<string, unknown>)
    await getDataApi().add('reading', {
      kind: 'progress',
      bookId: selected.id,
      date: dateKey(new Date()),
      minutes: Number.parseInt(progressMinutes || '0', 10) || 0,
      ...(selected.format === 'paper'
        ? { fromPage: selected.currentPage, toPage: raw }
        : { percent: raw }),
      // 从章节里记的那一条才写 nodeId（书级记录不写这个键，旧数据零改写）
      ...(logNodeId === null ? {} : { nodeId: logNodeId })
    })
    setProgressValue('')
    setLogOpen(false)
    setLogNodeId(null)
    await afterWrite()
    notify('已记一次阅读')
  }

  const finishBook = async (): Promise<void> => {
    if (!selected) return
    const review = normalizeRichText(finishReview.text, finishReview.format)
    await finishSave.run(async () => {
      await getDataApi().update('reading', selected.id, {
        ...(finishPatch(dateKey(new Date()), finishRating, review.text) as Record<string, unknown>),
        ...(review.contentFormat ? { contentFormat: review.contentFormat } : {})
      })
    })
    // 失败时把总评留在输入框里（判断用 finishSave.failed，不看返回值）
    if (finishSave.failed) return
    setFinishOpen(false)
    setFinishReview({ text: '', format: 'rich' })
    await afterWrite()
    notify('已标记读完')
  }

  // ---------------------------------------------------------------------
  // 摘录与想法（**只在中区那块列表里**，不进树——决定 24）
  // ---------------------------------------------------------------------

  const openExcerpt = (): void => {
    setExcerptType('quote')
    setExcerptLocator('')
    setExcerptOpen(true)
  }

  const saveExcerpt = async (text: string, format: ContentFormat): Promise<void> => {
    if (!selected) return
    const normalized = normalizeRichText(text, format)
    if (normalized.text === '') return
    await getDataApi().add('reading', {
      kind: 'excerpt',
      bookId: selected.id,
      type: excerptType,
      locator: excerptLocator.trim(),
      content: normalized.text,
      ...(normalized.contentFormat ? { contentFormat: normalized.contentFormat } : {})
    })
    setExcerptLocator('')
    setExcerptOpen(false)
    await afterWrite()
    notify('已记下')
  }

  const excerptToReview = async (excerpt: Excerpt): Promise<void> => {
    if (!selected) return
    const card = excerptToCard(excerpt, selected.title)
    await getDataApi().add('review', {
      front: card.front,
      back: card.back,
      source: card.source,
      stage: 0,
      dueDate: dateKey(new Date()),
      reviewCount: 0,
      lastReviewedAt: null
    })
    await getDataApi().flush()
    notifyDataChanged('review')
    notify('已生成复习卡')
  }

  const removeExcerpt = async (excerpt: Excerpt): Promise<void> => {
    await getDataApi().remove('reading', excerpt.id)
    await afterWrite()
    notify('已删除摘录')
  }

  // ---------------------------------------------------------------------
  // 章节树（第 02 块）：增 / 删 / 改 / 排序 / 折叠 / 完成
  // ---------------------------------------------------------------------

  /** 新增章节；`parent.id === ''` 表示新增一个顶层章（书为根） */
  const onAddChapter = (parent: TreeViewItem): void => {
    if (!selected) return
    const node =
      parent.id === ''
        ? null
        : bookNodes.find((candidate) => candidate.id === parent.id) ?? null
    setChapterParent(node)
    setChapterDraft('')
    setChapterDrawerOpen(true)
  }

  const saveNewChapter = async (): Promise<void> => {
    if (!selected || chapterDraft.trim() === '') return
    const siblings = bookNodes.filter((node) => node.parentId === (chapterParent?.id ?? null))
    await getDataApi().add('reading', {
      kind: 'node',
      ownerId: selected.id,
      parentId: chapterParent?.id ?? null,
      order: siblings.length === 0 ? 0 : Math.max(...siblings.map((node) => node.order)) + 1,
      title: chapterDraft.trim(),
      done: false
    })
    const parentId = chapterParent?.id ?? null
    setChapterDrawerOpen(false)
    if (parentId !== null) setNodeUi((current) => setExpanded(current, parentId, true))
    await afterWrite()
    notify('已添加章节')
  }

  const onToggleChapter = async (item: TreeViewItem, done: boolean): Promise<void> => {
    await getDataApi().update('reading', item.id, { done })
    await afterWrite()
  }

  /**
   * 就地改名：树行里的输入框提交时直接落盘。
   *
   * 这里**不再另开一个表单抽屉**——树的「改名」本来就是就地编辑，
   * 再弹一个抽屉会变成两条改名路径（已踩过：行内输入框一提交就被抽屉顶掉，
   * 结果"输入框收起来了，但名字没变"）。面板里的「重命名」走同一个写入口。
   */
  const onRenameChapter = async (item: TreeViewItem): Promise<void> => {
    const title = item.title.trim()
    if (title === '') return
    await getDataApi().update('reading', item.id, { title })
    await afterWrite()
    notify('已改名')
  }

  /** 面板里的「重命名」：输入框 + 保存 */
  const saveChapterRename = async (): Promise<void> => {
    if (chapterRename === null) return
    const title = chapterRename.value.trim()
    if (title === '') return
    await getDataApi().update('reading', chapterRename.id, { title })
    setChapterRename(null)
    await afterWrite()
    notify('已改名')
  }

  /** 就地记页码（引用到第几页），落成章节上的 `note` */
  const saveChapterNote = async (node: ReadingNode, raw: string): Promise<void> => {
    await getDataApi().update('reading', node.id, { note: raw.trim() })
    await afterWrite()
    notify(raw.trim() === '' ? '已清空页码' : '已记下页码')
  }

  /**
   * 移动章节。跨书移动与"移到自己的子章下"必须被拒 —— 判据在
   * `shared\tree.ts` 的 `moveNode`（有单测），这里只把补丁写回存储。
   */
  const onMoveChapter = async (
    dragId: string,
    target: { parentId: string | null; index: number }
  ): Promise<void> => {
    const fresh = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
    const nodes = splitReading(fresh).nodes
    const outcome = buildMovePatches(nodes, dragId, target.parentId, target.index)
    if (!outcome.ok) {
      await reload()
      notify(`不能移动：${outcome.reason ?? '位置不合法'}`)
      return
    }
    for (const patch of outcome.patches) {
      await getDataApi().update('reading', patch.id, patch.patch)
    }
    await afterWrite()
    notify('已调整位置')
  }

  /** 删除章节：连同子章一起，先解除关联再删（走 unlink.ts） */
  const confirmDeleteChapter = async (): Promise<void> => {
    if (!chapterDelete) return
    const fresh = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
    const nodes = splitReading(fresh).nodes
    const ids = subtreeIds(nodes, chapterDelete.id)
    const { patches } = unlinkTreeNode(chapterDelete.id, ids.slice(1), 'reading')
    for (const patch of patches) {
      await getDataApi().update(patch.module, patch.id, patch.patch)
    }
    setChapterDelete(null)
    await afterWrite()
    notify('已删除章节（可在回收站恢复）')
  }

  // ---------------------------------------------------------------------
  // 菜单（第 03 块）：内容全部来自 shared/contextMenu.ts 的那一份定义
  // ---------------------------------------------------------------------

  /**
   * 章节行的菜单项（右键挂点）。
   *
   * 层级语义（是不是汇总节点、能不能展开）由 `TreeView` 的 `actions` 算好，
   * 这里只做"翻译"，不重算一遍——两处各算一遍必然漂移。
   */
  const chapterMenuItems = (item: TreeViewItem, actions: TreeMenuActions): MenuItemSpec[] => {
    const node = bookNodes.find((candidate) => candidate.id === item.id)
    return toSpecs(
      treeNodeMenuFromActions(item, actions, {
        expanded: isExpanded(nodeUi, item.id),
        // 「更新进度」= 记一次阅读：挂在当前这一章上
        onEditMeasure: () => openLog(item.id),
        // 「改页码 / 进度说明」：写回节点的 `note`
        onEditNote: () => {
          if (!node) return
          setNoteDraft(node.note ?? '')
          setNoteEdit(node)
        }
      })
    )
  }

  /**
   * 这本书的菜单项（预览右上角的 `⋯`）。
   * 与章节行用的是**同一个定义文件**，所以不会出现两套说法。
   */
  const bookItems = (): MenuItemSpec[] => {
    if (!selected) return []
    return toSpecs(
      bookMenuItems({
        title: selected.title,
        status: selected.status,
        onEdit: () => openEditBook(),
        onDelete: () => void prepareDeleteBook(),
        onEditMeasure: () => openLog(null),
        onAddChapter: () =>
          onAddChapter({ id: '', parentId: null, order: bookNodes.length, title: '', done: false }),
        onToggleStatus: () => void markStatus(selected.status === 'finished' ? 'reading' : 'finished')
      })
    )
  }

  /**
   * 树的调试挂点：把**当前这本书真实的移动函数**交给验收，
   * 好让"跨书移动被拒"这条能在真实运行的程序里验一遍
   * （这条在界面上做不出来——页面只渲染当前这本书的章节）。
   */
  useTreeDebug({
    ownerId: selected?.id ?? '',
    items: bookNodes,
    loadNodeIds: async (module) => {
      const records = (await getDataApi().listAlive(module)) as Array<Record<string, unknown>>
      return records.filter((item) => item['kind'] === 'node').map((item) => String(item['id'] ?? ''))
    },
    canMove: (dragId, parentId) =>
      canMove(
        bookNodes.map((node) => ({
          id: node.id,
          ownerId: node.ownerId,
          parentId: node.parentId,
          order: node.order
        })),
        dragId,
        parentId
      ),
    tryMove: async (dragId, parentId, index) => {
      const fresh = (await getDataApi().list('reading')) as Array<Record<string, unknown>>
      const outcome = buildMovePatches(splitReading(fresh).nodes, dragId, parentId, index)
      if (!outcome.ok) {
        await reload()
        return outcome.reason
      }
      for (const patch of outcome.patches) {
        await getDataApi().update('reading', patch.id, patch.patch)
      }
      await afterWrite()
      return null
    }
  })

  // ---------------------------------------------------------------------
  // 中区两块（§6.3 / §7.2：固定 132px，**各自内部滚**）
  // ---------------------------------------------------------------------

  const excerptsCard = (
    <BandCard
      title="摘录与想法"
      count={bookExcerpts.length}
      testId="reading-excerpts"
      empty="还没有摘录。点上面的「加摘录」写第一条（摘录不进树，按页码在这里看）。"
    >
      <ul className="band-list">
        {bookExcerpts.map((excerpt) => (
          <li
            key={excerpt.id}
            className="band-list__row reading-excerpt"
            data-testid="reading-excerpt"
            data-excerpt-id={excerpt.id}
            data-type={excerpt.type}
          >
            <span className="reading-excerpt__tag" data-testid="reading-excerpt-type">
              {excerptTypeLabel(excerpt.type)} · {excerpt.locator || '未标位置'}
            </span>
            <span className="reading-excerpt__body">
              <RichTextView
                value={excerpt.content}
                format={excerpt.contentFormat}
                testId="reading-excerpt-text"
              />
            </span>
            <button
              type="button"
              className="link"
              data-testid="reading-excerpt-to-review"
              onClick={() => void excerptToReview(excerpt)}
            >
              → 复习
            </button>
            <button
              type="button"
              className="link link--danger"
              data-testid="reading-excerpt-delete"
              onClick={() => void removeExcerpt(excerpt)}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </BandCard>
  )

  const recordsCard = (
    <BandCard
      title="阅读记录"
      count={bookRecords.length}
      testId="reading-records"
      empty="还没有阅读记录。点上面的「记一次阅读」。"
    >
      <ul className="band-list">
        {bookRecords.map((record) => {
          const owner = recordOwnerText(record, bookNodes)
          return (
            <li
              key={record.id}
              className="band-list__row reading-record"
              data-testid="reading-record"
              data-record-id={record.id}
              data-node-id={record.nodeId ?? ''}
            >
              <span className="reading-record__date">{record.date}</span>
              <span className="reading-record__minutes">{record.minutes} 分钟</span>
              <span className="reading-record__pages" data-testid="reading-record-pages">
                {recordPagesText(record)}
              </span>
              {owner === '' ? null : (
                <span className="reading-record__owner" data-testid="reading-record-owner">
                  {owner}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </BandCard>
  )

  // ---------------------------------------------------------------------
  // 上预览（§6.2：作者 / 格式 / 读到 N/M 页 / 章节 n/m 章 / 记录 / 摘录）
  // ---------------------------------------------------------------------

  const preview =
    selected === null ? (
      <EmptyState message="左侧选一本书，或点右上角「添加书」。" testId="reading-detail-empty" />
    ) : (
      <div className="preview preview--reading" data-testid="reading-detail" data-book-id={selected.id}>
        <section className="preview__info" data-testid="reading-info">
          <header className="detail__head">
            <h2 className="detail__title" data-testid="reading-detail-title" title={selected.title}>
              {selected.title}
            </h2>
            <span
              className={`detail__badge reading-badge reading-badge--${selected.status}`}
              data-testid="reading-detail-status"
            >
              {statusLabel(selected.status)}
            </span>
            <span className="toolbar__spacer" />
            {/* 与章节行的右键取同一份菜单定义 */}
            <MenuButton menu={menu} items={bookItems} testId="reading-book-menu" className="button" />
          </header>
          {/* 一句话总评：按 contentFormat 渲染（旧书没有这个字段 → 纯文本） */}
          <RichTextView
            value={selected.review}
            format={selected.contentFormat}
            className="preview__desc"
            testId="reading-book-review"
          />
          <dl className="preview__facts">
            <div className="preview__fact">
              <dt>作者</dt>
              <dd data-testid="reading-fact-author">{facts?.author}</dd>
            </div>
            <div className="preview__fact">
              <dt>格式</dt>
              <dd data-testid="reading-fact-format">{facts?.format}</dd>
            </div>
            <div className="preview__fact">
              {/* 页码只作"读到哪了"的参考：它**不参与**进度计算（决定 23） */}
              <dt>读到</dt>
              <dd data-testid="reading-detail-progress">{facts?.pages}</dd>
            </div>
            <div className="preview__fact">
              <dt>章节</dt>
              <dd data-testid="reading-chapter-progress">{chapterProgressText(stats)}</dd>
            </div>
            <div className="preview__fact">
              <dt>阅读记录</dt>
              <dd data-testid="reading-fact-records">{facts?.records}</dd>
            </div>
            <div className="preview__fact">
              <dt>摘录 / 想法</dt>
              <dd data-testid="reading-fact-notes">{facts?.notes}</dd>
            </div>
          </dl>
        </section>

        <section className="preview__main" data-testid="reading-preview-main">
          <div className="progress" data-testid="reading-progress">
            <div
              className="progress__bar"
              title="书内完成度 ＝ 读完的章 ÷ 总章数（只数最小单元；页码只作参考）"
            >
              <div
                className="progress__fill"
                style={{ width: `${stats.percent}%` }}
                data-testid="reading-progress-fill"
                data-percent={stats.percent}
              />
            </div>
            <div className="progress__row">
              <span className="progress__value" data-testid="reading-progress-percent">
                {stats.percent}%
              </span>
              <span className="progress__auto" data-testid="reading-progress-basis">
                按章节算（读完 {stats.done}/{stats.total} 章）
              </span>
              <span className="toolbar__spacer" />
              <span className="progress__auto">
                摘录 {counts.quotes} · 想法 {counts.thoughts}
              </span>
            </div>
            <p className="panel__hint" data-testid="reading-spot">
              {spot}
            </p>
          </div>

          <div className="detail__actions">
            {/* 三步走的第二步入口：进／退都是它（决定 1、R2） */}
            <button
              type="button"
              className="button button--primary"
              data-testid="reading-enter-book"
              data-entered={entered ? '1' : '0'}
              onClick={() => setEnteredBookId(entered ? null : selected.id)}
            >
              {entered ? '收起章节' : '进入书'}
            </button>
            <button
              type="button"
              className="button"
              data-testid="reading-log-reading"
              onClick={() => openLog(null)}
            >
              记一次阅读
            </button>
            <button
              type="button"
              className="button"
              data-testid="reading-add-excerpt"
              onClick={openExcerpt}
            >
              加摘录
            </button>
            <button
              type="button"
              className="button"
              data-testid="reading-edit-book"
              onClick={openEditBook}
            >
              编辑
            </button>
            <button
              type="button"
              className="button"
              data-testid="reading-add-chapter"
              onClick={() =>
                onAddChapter({ id: '', parentId: null, order: bookNodes.length, title: '', done: false })
              }
            >
              加章节
            </button>
            {selected.status !== 'reading' ? (
              <button
                type="button"
                className="button"
                data-testid="reading-mark-reading"
                onClick={() => void markStatus('reading')}
              >
                标记在读
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              data-testid="reading-mark-finished"
              onClick={() => setFinishOpen(true)}
            >
              标记读完
            </button>
            <button
              type="button"
              className="button is-danger"
              data-testid="reading-delete-book"
              onClick={() => void prepareDeleteBook()}
            >
              删除
            </button>
          </div>
        </section>
      </div>
    )

  // ---------------------------------------------------------------------
  // 下主体：章节树（书为根 → 章 → 子章；**摘录不在这里**）
  // ---------------------------------------------------------------------

  const main =
    selected === null ? (
      <EmptyState
        message="在左边选一本书，这一块就是它的章节树。"
        testId="reading-tree-hint"
      />
    ) : !entered ? (
      <section className="panel panel--hint" data-testid="reading-tree-locked">
        <p className="panel__hint">
          点上面「进入书」，下方就会展开这本书的章节（书为根 → 章 → 子章）。
          摘录与想法不放进树里——它们永远不打勾，当叶子算会让进度永远偏低；它们留在上面那块列表里按页码看。
        </p>
      </section>
    ) : (
      <section className="panel" data-testid="reading-chapters">
        <header className="panel__head">
          <h3 className="panel__title">
            章节与摘录（{bookNodes.length} 个节点 · {stats.done}/{stats.total} 章 · {stats.percent}%）
          </h3>
          <span className="panel__note">
            书为根 → 章 → 子章；虚线框是汇总，实心框是最小单元；摘录不在这里
          </span>
        </header>
        <TreeView
          ownerId={selected.id}
          items={bookNodes}
          testIdPrefix="reading-tree"
          addRootLabel="加章节"
          emptyHint="还没有章节。点「加章节」建第一章，再在它下面加子章。"
          error={error}
          expandedIds={nodeUi.expandedIds}
          // 就地面板**单独一份**状态（2026-10 修订）：与子节点展开解耦
          openDetailIds={openDetailIdsOf(nodeUi)}
          onToggleExpand={(item, next) =>
            setNodeUi((current) => setExpanded(current, item.id, next))
          }
          onOpenDetail={(item) => {
            // 点章节行 → 就地展开/收起它的阅读记录与那五个操作
            setChapterRename(null)
            // 只改面板状态：**不再动** `expandedIds`
            setNodeUi((current) => toggleOpenPanel(current, item.id))
          }}
          progressOf={(item) => {
            const node = bookNodes.find((candidate) => candidate.id === item.id)
            if (!node) return null
            return chapterRowProgress(node, bookNodes)
          }}
          onToggleDone={(item, done) => void onToggleChapter(item, done)}
          onAddChild={onAddChapter}
          onRename={(item) => void onRenameChapter(item)}
          onDelete={(item) => {
            const node = bookNodes.find((candidate) => candidate.id === item.id)
            if (node) setChapterDelete(node)
          }}
          onMove={(dragId, target) => void onMoveChapter(dragId, target)}
          // 读书树的顶层是**章**：章降成"上一章的子章"是正常动作（`1` → `1.1`），
          // 所以这里显式允许顶层降级（学习树的顶层是资料，那边不给降，见 `TreeView` 的说明）
          allowRootDemote
          // 第 03 块：章节行的右键菜单（与书的 `⋯` 取同一份定义文件）
          onContextMenuItems={(item, actions, event) => {
            // 只算一次：`chapterMenuItems` 里会做"id 不许重复"的检查，
            // 算两遍既浪费又容易在以后改坏
            const items = chapterMenuItems(item, actions)
            setPendingMenu({
              point: { x: event.clientX, y: event.clientY },
              items,
              source: `chapter-row:${item.id}`
            })
            return items
          }}
          onMenuItems={(item, actions) => chapterMenuItems(item, actions)}
          onRequestMenu={(item, actions, point) =>
            setPendingMenu({
              point,
              items: chapterMenuItems(item, actions),
              source: `chapter-menu:${item.id}`
            })
          }
          nodeContent={(item) => {
            const node = bookNodes.find((candidate) => candidate.id === item.id)
            if (!node) return null
            const chapterRecords = recordsOfChapter(data.progress, node.id)
            const isSummary = bookNodes.some((candidate) => candidate.parentId === node.id)
            return (
              <div className="tree__logbox" data-testid="reading-chapter-detail" data-node-id={node.id}>
                {/*
                  面板右上角的「收起」（2026-10 修订）。
                  以前面板没有任何收起入口——用户只能猜"再点这一行"。
                  这里给一个**明确可见**的按钮，同时"再点这一行"与 `Esc` 也都能收；
                  位置、文案、class 与学习页**完全一致**（§6.4 第 6 条）。
                */}
                <div className="tree__detail-head">
                  <span className="panel__hint">这一章的阅读记录</span>
                  <span className="toolbar__spacer" />
                  <button
                    type="button"
                    className="link"
                    data-testid="reading-chapter-panel-collapse"
                    title="收起这一块（与再点一次这一行、按 Esc 都是同一个动作）"
                    onClick={() => {
                      setChapterRename(null)
                      setNodeUi((current) => closeOpenPanel(current))
                    }}
                  >
                    收起
                  </button>
                </div>
                {/*
                  点章节后的五个操作（§7.7）：记一次阅读 / 加子章 / 重命名 / 标记读完 / 删除。

                  **排在记录上面**：以前树那一块的可视高度只有一百多像素（上预览 + 中区两块先占着），
                  操作排在记录下面就会被挡在滚动区之外，用户点开一章却看不到「记一次阅读」。
                  2026-10 起下区跟随整页滚，挡是挡不住了，但**顺序保持不变**——
                  用户已经习惯了"看见这一章就先看见那几个按钮"。
                */}
                <div className="detail__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    data-testid="reading-chapter-log"
                    onClick={() => openLog(node.id)}
                  >
                    记一次阅读
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="reading-chapter-add-sub"
                    onClick={() => onAddChapter({ ...item })}
                  >
                    加子章
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="reading-chapter-rename"
                    onClick={() => setChapterRename({ id: node.id, value: node.title })}
                  >
                    重命名
                  </button>
                  {isSummary ? null : (
                    <button
                      type="button"
                      className="button"
                      data-testid="reading-chapter-mark-done"
                      onClick={() => void onToggleChapter(item, !node.done)}
                    >
                      {node.done ? '取消读完' : '标记读完'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button is-danger"
                    data-testid="reading-chapter-delete"
                    onClick={() => setChapterDelete(node)}
                  >
                    删除
                  </button>
                </div>

                <div className="panel__head">
                  <span className="panel__hint" data-testid="reading-chapter-record-count">
                    这一章的阅读记录（{chapterRecords.length}）
                  </span>
                  <span className="toolbar__spacer" />
                  <span className="panel__hint">页码只作参考，进度按章节算</span>
                </div>
                {chapterRecords.length === 0 ? (
                  <p className="panel__hint" data-testid="reading-chapter-record-empty">
                    这一章还没有单独的阅读记录。
                  </p>
                ) : (
                  <ul className="log-list">
                    {chapterRecords.map((record) => (
                      <li key={record.id} className="log" data-testid="reading-chapter-record">
                        <div className="log__head">
                          <span className="log__date">{record.date}</span>
                          <span className="log__minutes">{record.minutes} 分钟</span>
                          <span>{recordPagesText(record)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {chapterRename !== null && chapterRename.id === node.id ? (
                  <div className="inline-row">
                    <input
                      className="field__control field__control--short"
                      value={chapterRename.value}
                      data-testid="reading-chapter-rename-input"
                      onChange={(event) =>
                        setChapterRename({ id: node.id, value: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="button button--primary"
                      data-testid="reading-chapter-rename-save"
                      onClick={() => void saveChapterRename()}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="reading-chapter-rename-cancel"
                      onClick={() => setChapterRename(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            )
          }}
        />
      </section>
    )

  return (
    <PageShell
      title="读书"
      /*
        内容区吃满剩余高度 + **下区跟随整页滚**（2026-10 修订 · `MASTER.md` §7.2 / 决定 7）：
        与学习页同一套（三处必须长得一样，决定 1 / 7）。
      */
      fill
      scroll
      description={
        selected === null
          ? `${data.books.length} 本 · 书架按 在读 / 想读 / 读完 三档排`
          : `${data.books.length} 本 · 当前：${selected.title}${entered ? ' · 已展开章节' : ''}`
      }
      primaryAction={{
        label: '添加书',
        testId: 'reading-add-book',
        onClick: () => setBookDrawerOpen(true)
      }}
      toolbar={
        <>
          <input
            className="toolbar__search"
            placeholder="搜索书名或作者…"
            value={term}
            data-testid="reading-search"
            onChange={(event) => setTerm(event.target.value)}
          />
          <span className="toolbar__spacer" />
          <span className="panel__hint">
            在读 {data.books.filter((book) => book.status === 'reading').length} · 想读{' '}
            {data.books.filter((book) => book.status === 'want').length} · 读完{' '}
            {data.books.filter((book) => book.status === 'finished').length}
          </span>
        </>
      }
    >
      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}
      {flash ? (
        <p className="notice notice--ok" data-testid="reading-flash">
          {flash}
        </p>
      ) : null}

      {/*
        左栏中段：书架（§7.7 的"封面色块 + 书名首字 + 三档状态 + 进度细线"）。
        列表用 portal 塞进侧栏，但数据、选中状态、点击行为**都留在这一页**。
      */}
      <SidebarListPortal>
        <div className="sidebar-list" data-testid="reading-shelf">
          <div className="sidebar-list__head">
            <span>书架</span>
            <span>{visibleBooks.length}</span>
          </div>
          {visibleBooks.length === 0 ? (
            <p className="sidebar-list__empty" data-testid="reading-empty">
              {term.trim() === ''
                ? '书架是空的。点右上角「添加书」，或按 N 新建一本。'
                : '没有匹配的书。'}
            </p>
          ) : (
            <ul className="topic-list">
              {visibleBooks.map((book) => {
                const bookNodeList = nodesOf(book.id)
                const percent = chapterStats(bookNodeList).percent
                const active = selected?.id === book.id
                return (
                  <li key={book.id}>
                    <button
                      type="button"
                      className={`book-row${active ? ' book-row--active' : ''}`}
                      data-testid="reading-book"
                      data-book-id={book.id}
                      data-status={book.status}
                      data-percent={percent}
                      data-active={active ? '1' : '0'}
                      title={book.title}
                      onClick={() => selectBook(book)}
                    >
                      {/* 封面：纯色块 + 书名首字（不做图片上传） */}
                      <span
                        className="book-row__cover"
                        data-testid="reading-book-cover"
                        style={{ background: `hsl(${coverHue(book.title)} 45% 62%)` }}
                        aria-hidden="true"
                      >
                        {shelfCoverInitial(book)}
                      </span>
                      <span className="book-row__body">
                        <span className="book-row__title">{book.title}</span>
                        <span className="book-row__meta" data-testid="reading-book-progress">
                          {shelfMetaText(book, bookNodeList)}
                        </span>
                        {/* 进度细线：**按章节算**，不是按页码 */}
                        <span className="book-row__bar">
                          <span
                            className="book-row__fill"
                            data-testid="reading-book-bar"
                            data-percent={percent}
                            style={{ width: `${percent}%` }}
                          />
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SidebarListPortal>

      {/* 三段骨架：上预览 / 中两块 / 下树（§7.1；预览与卡片不整页替换，决定 1） */}
      <ModuleBands testId="reading-bands" cards={[excerptsCard, recordsCard]} preview={preview}>
        {main}
      </ModuleBands>

      {/* 记一次阅读（页码 / 百分比 + 时长；从章节记时挂在该章上） */}
      <Drawer
        open={logOpen && selected !== null}
        title={logNode === null ? '记一次阅读' : `记一次阅读 · ${logNode.title}`}
        onClose={() => setLogOpen(false)}
        testId="reading-log-drawer"
        footer={
          <button
            type="button"
            className="button button--primary"
            data-testid="reading-progress-save"
            onClick={() => void saveLog()}
          >
            保存
          </button>
        }
      >
        <p className="panel__hint">
          {selected ? `《${selected.title}》` : ''}
          {logNode === null ? '' : ` · 这一条会挂在「${logNode.title}」上`}
        </p>
        <label className="field">
          <span className="field__label">
            {selected?.format === 'ebook' ? '读到百分之几' : '读到第几页'}
          </span>
          <input
            className="field__control"
            type="number"
            min={0}
            placeholder={
              selected?.format === 'ebook'
                ? `当前 ${selected.percent}%`
                : `当前 ${selected?.currentPage ?? 0} 页`
            }
            value={progressValue}
            data-testid="reading-progress-input"
            onChange={(event) => setProgressValue(event.target.value)}
          />
        </label>
        <div className="field">
          <span className="field__label">这次读了多久</span>
          <div className="preset-row">
            {MINUTE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`chip${progressMinutes === String(preset) ? ' chip--active' : ''}`}
                data-testid={`reading-minutes-${preset}`}
                onClick={() => setProgressMinutes(String(preset))}
              >
                {preset} 分钟
              </button>
            ))}
            <input
              className="field__control field__control--short"
              type="number"
              min={0}
              max={1440}
              value={progressMinutes}
              data-testid="reading-minutes-input"
              onChange={(event) => setProgressMinutes(event.target.value)}
            />
          </div>
        </div>
        <p className="panel__hint">
          页码只作"读到哪了"的参考：书的进度**按章节算**（读完的章 ÷ 总章数）。
        </p>
      </Drawer>

      {/* 加摘录 / 想法（摘录只留在中区那块列表里，**不进树**） */}
      <Drawer
        open={excerptOpen && selected !== null}
        title="加摘录 / 想法"
        onClose={() => setExcerptOpen(false)}
        testId="reading-excerpt-drawer"
      >
        <div className="preset-row">
          <button
            type="button"
            className={`chip${excerptType === 'quote' ? ' chip--active' : ''}`}
            data-testid="reading-excerpt-type-quote"
            onClick={() => setExcerptType('quote')}
          >
            原文
          </button>
          <button
            type="button"
            className={`chip${excerptType === 'thought' ? ' chip--active' : ''}`}
            data-testid="reading-excerpt-type-thought"
            onClick={() => setExcerptType('thought')}
          >
            想法
          </button>
          <input
            className="field__control field__control--short"
            placeholder="p.112"
            value={excerptLocator}
            data-testid="reading-excerpt-locator"
            onChange={(event) => setExcerptLocator(event.target.value)}
          />
        </div>
        <RichTextComposer
          testId="reading-excerpt-input"
          placeholder="写下原文或想法…（回车保存，Shift+回车换行）"
          submitKey="enter"
          minHeight={110}
          onSubmit={(text, format) => saveExcerpt(text, format)}
        />
      </Drawer>

      {/* 加章节（树节点）——层数不限 */}
      <Drawer
        open={chapterDrawerOpen}
        title={chapterParent === null ? '添加章节' : `在「${chapterParent.title}」下添加`}
        onClose={() => setChapterDrawerOpen(false)}
        testId="reading-chapter-drawer"
        footer={
          <button
            type="button"
            className="button button--primary"
            data-testid="reading-chapter-save"
            onClick={() => void saveNewChapter()}
          >
            保存
          </button>
        }
      >
        <label className="field">
          <span className="field__label">章节名</span>
          <input
            className="field__control"
            value={chapterDraft}
            placeholder="例如：第 1 章 · 计算机系统漫游"
            data-testid="reading-chapter-title"
            onChange={(event) => setChapterDraft(event.target.value)}
          />
        </label>
        <p className="panel__hint">
          层数不限：在子章上继续「+子章」就能建到 1.1.1.1。第 5 层起缩进会自动收窄到 12px。
        </p>
      </Drawer>

      {/* 改页码 / 进度说明（章节行菜单里的那一项；写回节点的 `note`） */}
      <FormDrawer
        open={noteEdit !== null}
        title="改页码 / 进度说明"
        fields={[
          {
            kind: 'text',
            key: 'note',
            label: '读到哪了',
            placeholder: '例如：p.128 或 第 3 章',
            testId: 'reading-note-input'
          }
        ]}
        initialValues={{ note: noteDraft }}
        onClose={() => setNoteEdit(null)}
        onSubmit={async (values) => {
          if (!noteEdit) return
          await saveChapterNote(noteEdit, values['note'] ?? '')
          setNoteEdit(null)
        }}
        testId="reading-note-form"
      />

      {/* 删除章节（连同子章） */}
      <ConfirmDialog
        open={chapterDelete !== null}
        title="删除这一章？"
        message={
          <>
            <p data-testid="reading-chapter-delete-summary">
              「{chapterDelete?.title ?? ''}」连同它下面的全部子章会一起删除。
            </p>
            <p>阅读记录与摘录会保留；删除后可在「数据与设置 → 回收站」里恢复。</p>
          </>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDeleteChapter()}
        onCancel={() => setChapterDelete(null)}
        testId="reading-chapter-delete-dialog"
      />

      {/* 编辑书（BUG-002） */}
      <FormDrawer
        open={editOpen}
        title="编辑书籍信息"
        fields={[
          {
            kind: 'text',
            key: 'title',
            label: '书名',
            required: true,
            testId: 'reading-edit-title'
          },
          { kind: 'text', key: 'author', label: '作者', testId: 'reading-edit-author' },
          {
            kind: 'select',
            key: 'format',
            label: '格式',
            testId: 'reading-edit-format',
            options: [
              { value: 'paper', label: '纸质书' },
              { value: 'ebook', label: '电子书' }
            ]
          },
          {
            kind: 'number',
            key: 'totalPages',
            label: '总页数（纸质书）',
            min: 0,
            testId: 'reading-edit-pages',
            hint: '电子书此项会被忽略'
          },
          {
            kind: 'select',
            key: 'status',
            label: '状态',
            testId: 'reading-edit-status',
            options: [
              { value: 'want', label: '想读' },
              { value: 'reading', label: '在读' },
              { value: 'finished', label: '读完' }
            ]
          },
          {
            kind: 'number',
            key: 'rating',
            label: '评分（0–5）',
            min: 0,
            max: 5,
            testId: 'reading-edit-rating'
          },
          {
            // 一句话总评改成富文本（第 04 块）：值仍是字符串，内容是净化后的 HTML
            kind: 'rich',
            key: 'review',
            label: '一句话总评',
            placeholder: '读完的感受…（可以用工具条加粗、分点）',
            minHeight: 110,
            testId: 'reading-edit-review'
          }
        ]}
        initialValues={editInitial}
        initialFormats={editFormats}
        onClose={() => setEditOpen(false)}
        onSubmit={onSaveBookEdit}
        testId="reading-edit-form"
      />

      {/* 删除确认（BUG-007） */}
      <ConfirmDialog
        open={deleteOpen}
        title="删除这本书？"
        message={
          <>
            <p>仅删除当前这本书，关联内容将解除关联但保留。</p>
            <p className="dialog__detail" data-testid="reading-delete-summary">
              {deleteSummary}
            </p>
            <p>删除后可在「数据与设置 → 回收站」里恢复。</p>
          </>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDeleteBook()}
        onCancel={() => setDeleteOpen(false)}
        testId="reading-delete-dialog"
      />

      {/* 添加书 */}
      <Drawer
        open={bookDrawerOpen}
        title="添加书"
        onClose={() => setBookDrawerOpen(false)}
        testId="reading-add-drawer"
        footer={
          <button
            type="button"
            className="button button--primary"
            data-testid="reading-new-save"
            onClick={() => void addBook()}
          >
            加入书架
          </button>
        }
      >
        <label className="field">
          <span className="field__label">书名</span>
          <input
            className="field__control"
            value={newTitle}
            data-testid="reading-new-title"
            onChange={(event) => setNewTitle(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">作者</span>
          <input
            className="field__control"
            value={newAuthor}
            data-testid="reading-new-author"
            onChange={(event) => setNewAuthor(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">格式</span>
          <select
            className="field__control"
            value={newFormat}
            data-testid="reading-new-format"
            onChange={(event) => setNewFormat(event.target.value as BookFormat)}
          >
            <option value="paper">纸质书</option>
            <option value="ebook">电子书</option>
          </select>
        </label>
        {newFormat === 'paper' ? (
          <label className="field">
            <span className="field__label">总页数</span>
            <input
              className="field__control"
              type="number"
              min={0}
              value={newTotalPages}
              placeholder="例如 320"
              data-testid="reading-new-pages"
              onChange={(event) => setNewTotalPages(event.target.value)}
            />
          </label>
        ) : null}
      </Drawer>

      {/* 标记读完 */}
      <Drawer
        open={finishOpen && selected !== null}
        title="标记读完"
        onClose={() => setFinishOpen(false)}
        testId="reading-finish-drawer"
        footer={
          <div className="form__footer">
            {/* 保存三态必须可见（第 04 块：新增的编辑区都要接） */}
            <SaveHint save={finishSave} testId="reading-finish-save-state" />
            <span className="toolbar__spacer" />
            <button
              type="button"
              className="button button--primary"
              data-testid="reading-finish-save"
              disabled={finishSave.state === 'saving'}
              onClick={() => void finishBook()}
            >
              保存
            </button>
          </div>
        }
      >
        <p className="panel__hint">读完日期：{dateKey(new Date())}</p>
        <label className="field">
          <span className="field__label">评分</span>
          <div className="preset-row">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className={`chip${finishRating === value ? ' chip--active' : ''}`}
                data-testid={`reading-rating-${value}`}
                onClick={() => setFinishRating(value)}
              >
                {'★'.repeat(value)}
              </button>
            ))}
          </div>
        </label>
        <div className="field">
          <span className="field__label">一句话总评</span>
          <RichText
            value={finishReview.text}
            format={finishReview.format}
            placeholder="读完的感受…（可以用工具条加粗、分点）"
            testId="reading-finish-review"
            minHeight={110}
            onChange={(text, format) => setFinishReview({ text, format })}
          />
        </div>
      </Drawer>

      {/* 菜单只有这一个实例：书的 `⋯` 与章节行的右键都往它里面塞菜单项 */}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </PageShell>
  )
}
