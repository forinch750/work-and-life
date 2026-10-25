/**
 * 学习页（DEVPLAN 阶段 5 / PRD §5.3；第 02 块接入树；**第 09 块按定稿重做界面**）
 *
 * ## 布局（`MASTER.md` §7.5 那张图，照做的）
 *
 * ```
 * ┌ 左栏（永不动） ┬ 上：预览（信息卡 + 进度条 + 按钮排）          ┐
 * │ 主题1          │ ─────────────────────────────────────────  │
 * │ 主题2 ↕滚      │ 中：资料 卡  |  学习日志 卡（固定高，各自滚）│
 * │ 主题3          │ ─────────────────────────────────────────  │
 * │ ─────────      │ 下：资料与章节树（**按内容高，随整页往下翻**）│
 * │ 数据与设置     │                                             │
 * └────────────────┴─────────────────────────────────────────────┘
 * ```
 *
 * **三步走**（决定 1 / §6.6）：选中主题 → 看预览（含中区两块）→ 点「进入主题」→
 * **下方**展开树。预览与卡片**留在上面，不整页替换**，所以三段是同一个布局的三行，
 * 不是三个页面（骨架见 `shell/ModuleBands.tsx`）。
 *
 * ## 本块只重做界面，不重写逻辑
 *
 * - 进度公式：**一行都没写**，全部走 `shared/treeProgress.ts` 的公共实现
 *   （页面用到的那些口径收在 `shared/learningPageView.ts`，那里也只做转调）
 * - 树：`shell/TreeView.tsx`（第 02 块）原样复用，虚线框 / 实心框 / 缩进规则都在里面
 * - 数据读写：`useLearning()` 原样复用；日志挂在章节上是决定 16
 *
 * ## 两条**不许写**的联动
 *
 * - **树上的勾不改主题状态**（决定 30 / R4 / `TASKS\02` §5.6）：
 *   树全打勾 ≠ 主题「已完成」。状态**只由**预览区的「标记完成 / 归档」改变。
 * - **不按内容长度撑高页面**（§7.2）：中区两块 132px 各自滚、树吃满剩余高度自己滚，
 *   整页永不出现滚动条。
 *
 *   ⚠️ **2026-10 修订**：这一条只对了一半。用户要求"滚动整个页面时下区跟着往下翻"，
 *   所以下区与树现在**就是按内容高**的，滚动由右侧内容区 `.workspace` 承担；
 *   中区两块仍是 132px 各自滚；页面级（`html`/`body`）仍然永不出现滚动条。
 *   落地在 `styles/layout.css` 的 `page--scroll` 一节。
 */
import { useEffect, useMemo, useState } from 'react'
import { dateKey } from '../../../shared/date'
import {
  TOPIC_STATUS_LABELS,
  clampProgress,
  clampMinutes,
  sortLogs,
  studyMarks,
  summarizeTopics,
  type LearningLog,
  type LearningNode,
  type LearningTopic,
  type TopicStatus
} from '../../../shared/learning'
import { logToCard } from '../../../shared/learning'
import {
  clampTargetDays,
  isTopicEntered,
  resourceCardMeta,
  resourceLabel,
  rowProgressText,
  topicListMeta,
  topicListMetaText,
  topicLogs,
  topicPercent,
  topicPreviewFacts,
  topicStatusActions
} from '../../../shared/learningPageView'
import type { ContentFormat } from '../../../shared/richText'
import { normalizeRichText } from '../../../shared/richText'
import { clampShare } from '../../../shared/treeProgress'
import { canMove } from '../../../shared/treeMove'
import { unlinkLearningTopic } from '../../../shared/unlink'
import {
  EMPTY_NODE_PANEL_STATE,
  closeOpenPanel,
  isExpanded,
  openDetailIdsOf,
  setExpanded,
  toggleExpanded,
  toggleOpenPanel,
  type NodePanelState
} from '../../../shared/nodePanel'
import { getDataApi } from '../../lib/dataClient'
import { notifyDataChanged } from '../../lib/dataEvents'
import { focusByTestId } from '../../lib/domFocus'
import { useSaveState } from '../../lib/saveState'
import { usePanelEscape } from '../../lib/usePanelEscape'
import { useSignal } from '../../lib/useSignal'
import { PageShell } from '../../shell/PageShell'
import { EmptyState } from '../../shell/EmptyState'
import { ConfirmDialog, Drawer, FormDrawer, InlineInput, type FormValues } from '../../shell/Editors'
import { BandCard, ModuleBands } from '../../shell/ModuleBands'
import { SidebarListPortal } from '../../shell/SidebarSlot'
import { RichText } from '../../shell/RichText'
import { RichTextComposer, SaveHint } from '../../shell/RichTextComposer'
import { RichTextView } from '../../shell/RichTextView'
import { TreeView, type TreeMenuActions, type TreeViewItem } from '../../shell/TreeView'
import { useTreeDebug } from '../../shell/treeDebug'
import { ContextMenu, MenuButton, useContextMenu } from '../../shell/ContextMenu'
import { toSpecs, treeNodeMenuFromActions, resourceRowMenuItems } from '../../../shared/contextMenu'
import type { MenuItemSpec } from '../../../shared/menuItems'
import { useLearning } from './useLearning'

const STATUS_ORDER: TopicStatus[] = ['active', 'done', 'archived']
const MINUTE_PRESETS = [15, 30, 60]

/** "记一次学习"抽屉里那份草稿（正文是富文本，第 04 块） */
interface LogDraft {
  text: string
  format: ContentFormat
}

const EMPTY_LOG_DRAFT: LogDraft = { text: '', format: 'rich' }

export interface LearningPageProps {
  /** 热键 `N`（当前模块新建一条）：数字变一次 = 把焦点放到"新建学习主题"输入框 */
  newSignal?: number
}

export function LearningPage({ newSignal }: LearningPageProps = {}): React.JSX.Element {
  const learning = useLearning()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * 三步走的第二步（决定 1 / §6.6）：**已经「进入」的那个主题 id**。
   *
   * 「进入主题」不是路由、也不是整页替换——它只决定**下方树那一段显不显示**。
   * 所以状态就是一个 id：`entered` = 它等于当前选中的主题。
   * 换一个主题（id 对不上）自动回到"未进入"，这里不需要额外清理代码。
   *
   * 10（复习页）/ 11（读书页）**照抄这三行**（状态 + `isTopicEntered` + 下面的按钮），
   * 别各自发明一套开关。
   */
  const [enteredTopicId, setEnteredTopicId] = useState<string | null>(null)
  const [logDrawerOpen, setLogDrawerOpen] = useState(false)
  const [resourceDrawerOpen, setResourceDrawerOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  /** 编辑主题表单（BUG-002） */
  const [editOpen, setEditOpen] = useState(false)
  const [editInitial, setEditInitial] = useState<FormValues>({
    title: '',
    description: '',
    targetDays: ''
  })
  /** 删除确认（BUG-007）：先算清影响范围，再让用户确认 */
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteSummary, setDeleteSummary] = useState('')

  // 表单状态
  const [logMinutes, setLogMinutes] = useState(30)
  /** 正文改成富文本（第 04 块）：草稿带格式标记，保存失败时保留 */
  const [logDraft, setLogDraft] = useState<LogDraft>(EMPTY_LOG_DRAFT)
  const logSave = useSaveState()
  const [resourceName, setResourceName] = useState('')
  const [resourceType, setResourceType] = useState('书')
  /** 分组名（第 09 块）：用户自己填，例如"教材 / 参考 / 习题" */
  const [resourceGroup, setResourceGroup] = useState('')
  const [resourceProgress, setResourceProgress] = useState('')
  const [resourcePercent, setResourcePercent] = useState('')

  /**
   * 热键 `N` = 新建学习主题（决定 29）。
   *
   * 与页头「新主题」按钮**同一个动作**：把焦点放到行内输入框，而不是再开一个表单——
   * 学习页的新建本来就是"在顶部连着敲几条"，弄成弹窗反而更慢。
   */
  useSignal(newSignal, () => {
    focusByTestId('learning-new-topic-input')
  })

  /** 树节点：新增抽屉 / 重命名抽屉 / 删除确认 / 就地改占比（第 02 块） */
  const [nodeDrawerOpen, setNodeDrawerOpen] = useState(false)
  const [nodeParent, setNodeParent] = useState<LearningNode | null>(null)
  const [nodeTitleDraft, setNodeTitleDraft] = useState('')
  const [nodeDelete, setNodeDelete] = useState<LearningNode | null>(null)
  const [shareEdit, setShareEdit] = useState<{ id: string; value: string } | null>(null)
  const [renaming, setRenaming] = useState<LearningNode | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 「改页码 / 进度说明」抽屉：改的是节点的 `note`（"第 3/10 章"这种） */
  const [noteEdit, setNoteEdit] = useState<LearningNode | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /**
   * 树行的两层展开状态（2026-10 修订）：**子节点展开** vs **就地面板**。
   *
   * 以前这两件事共用一个数组（`expandedNodeIds`），后果是"想收面板但保留子节点
   * 展开做不到"、"收子节点把面板也弄没了"。现在拆开：
   *   - `expandedIds`   数组：祖先链要能同时展开（改成单值是踩过的坑）
   *   - `openPanelId`   单值：同屏只开一个面板
   * 纯逻辑在 `shared/nodePanel.ts`（有单测），这里只存状态。
   */
  const [nodeUi, setNodeUi] = useState<NodePanelState>(EMPTY_NODE_PANEL_STATE)
  /** 挂在章节上的那次"记一次学习"的时长 */
  const [nodeLogMinutes, setNodeLogMinutes] = useState(30)
  /**
   * 树行的菜单（第 03 块）。
   *
   * 菜单项的**内容**来自 `shared/contextMenu.ts` 的 `treeNodeMenuFromActions`；
   * 这里只负责把 `TreeView` 算好的层级动作（加子节点/改名/删除/打勾/展开）
   * 接到页面自己的写数据函数上——同一份定义，别处（右键与 `⋯`）也用它。
   */
  const menu = useContextMenu()
  /**
   * 待打开的右键菜单。
   *
   * 为什么绕一道：`TreeViewProps.onContextMenuItems` 会在**行的渲染过程中被调用**
   * （组件按行调它来拿菜单项）。在渲染期间去开菜单就等于"渲染期间改状态"，
   * 容易踩 React 的 "Cannot update a component while rendering a different
   * component" 警告，也会因为菜单实例每次渲染都换新对象而重算。
   * 所以这里先记下来，由 effect 在提交之后再打开——同一个结果，少一类隐患。
   */
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

  /**
   * `Esc` 收起就地面板（2026-10 修订）。
   *
   * 与读书页走**同一个 hook**，所以两页的 Esc 行为一致；
   * 抽屉 / 对话框开着时让给它们（它们自己用 Esc 关闭）。
   */
  usePanelEscape(nodeUi.openPanelId !== null, () =>
    setNodeUi((current) => closeOpenPanel(current))
  )

  const summaries = useMemo(
    () => summarizeTopics(learning.topics, learning.resources, learning.logs),
    [learning.topics, learning.resources, learning.logs]
  )

  const visible = useMemo(() => {
    const list = summaries.filter((item) =>
      showArchived ? true : item.topic.status !== 'archived'
    )
    return list.sort((a, b) => {
      const order = STATUS_ORDER.indexOf(a.topic.status) - STATUS_ORDER.indexOf(b.topic.status)
      if (order !== 0) return order
      return a.topic.title.localeCompare(b.topic.title, 'zh-Hans-CN')
    })
  }, [summaries, showArchived])

  const selected = useMemo(() => {
    const id = selectedId ?? visible[0]?.topic.id ?? null
    if (!id) return null
    return summaries.find((item) => item.topic.id === id) ?? null
  }, [selectedId, visible, summaries])

  /** 三步走：进入过这个主题没有（决定 1） */
  const entered = isTopicEntered(enteredTopicId, selected?.topic.id ?? null)

  const topicResources = selected
    ? learning.resources.filter((item) => item.topicId === selected.topic.id)
    : []
  /** 选中主题下的整棵树（资料是根节点，章 / 子章挂在下面） */
  const topicNodes = useMemo(
    () =>
      selected
        ? learning.nodes.filter(
            (node) => node.ownerId === selected.topic.id || node.topicId === selected.topic.id
          )
        : [],
    [learning.nodes, selected]
  )
  /** 只属于某个节点自己的日志（决定 16：日志挂在章节上） */
  const logsOfNode = (nodeId: string): typeof learning.logs =>
    sortLogs(learning.logs.filter((log) => log.nodeId === nodeId))
  /**
   * 主题的全部学习日志：**含挂在章节上的那些**（§6.3 的「学习日志」一块）。
   *
   * 与 09 块之前的区别：以前这块只列"没挂章节"的日志，于是挂在章节上的记录
   * 只能进章节里才看得到，中区那一块看起来总是空的。
   */
  const allTopicLogs = useMemo<LearningLog[]>(
    () => (selected ? topicLogs(learning.logs, selected.topic.id) : []),
    [learning.logs, selected]
  )
  const marks = studyMarks(allTopicLogs)

  /**
   * 某个主题的树（左栏列表要给**每个**主题算进度，不只是选中的那个）。
   * 与 `topicNodes` 同一条筛选口径，只是换成按 id 取。
   */
  const topicNodesOf = (topicId: string): LearningNode[] =>
    learning.nodes.filter((node) => node.ownerId === topicId || node.topicId === topicId)
  /** 左栏每一行要显示的四样东西（名字由主题行自己给，这里给后三样） */
  const listMeta = (topicId: string): ReturnType<typeof topicListMeta> =>
    topicListMeta(topicId, topicNodesOf(topicId), learning.logs)

  /** 主题进度 = Σ(资料占比 × 资料内部完成度) ÷ Σ占比（公共实现，别在这里重算） */
  const computedTopicProgress = selected ? topicPercent(topicNodes, selected.topic.id) : 0
  /** 预览区左侧信息卡的四行（开始 / 时限 / 资料 / 学习记录） */
  const previewFacts = selected
    ? topicPreviewFacts(selected.topic, topicNodes, learning.logs)
    : null

  // 验收用：把父子映射写到 window 上。
  // 树行在 DOM 里只有 depth，还原不出 parentId；而验收要沿祖先链逐级展开
  // （界面是手风琴式的，想看到第 6 层必须 1→2→3→4→5 全开着），所以需要这份映射。
  useEffect(() => {
    const host = window as unknown as { __treeParentMap?: Record<string, string | null> }
    host.__treeParentMap = Object.fromEntries(topicNodes.map((node) => [node.id, node.parentId]))
  }, [topicNodes])

  const notify = (text: string): void => {
    setFlash(text)
    setTimeout(() => setFlash(null), 2000)
  }

  const onAddTopic = async (title: string): Promise<void> => {
    await learning.addTopic(title)
    notify('已新建主题')
  }

  /** 保存主题编辑（BUG-002：以前已建主题改不了标题与说明） */
  const onSaveTopicEdit = async (values: FormValues): Promise<void> => {
    if (!selected) throw new Error('没有选中的主题')
    const title = (values['title'] ?? '').trim()
    if (title === '') throw new Error('主题不能为空')
    await learning.updateTopic(selected.topic.id, {
      title,
      description: (values['description'] ?? '').trim(),
      // 时限：留空 / 填 0 / 乱填都当"没设"，不写 0（0 天没有意义，见 clampTargetDays）
      targetDays: clampTargetDays(values['targetDays'])
    })
    notify('已保存')
  }

  /**
   * 打开删除确认前先算清影响范围。
   * 需求要求弹窗明确说明"仅删除当前项，关联内容将解除关联但保留"，
   * 所以这里先把摘要算出来给用户看，而不是删完再说。
   */
  const prepareDelete = async (): Promise<void> => {
    if (!selected) return
    const learningRecords = (await getDataApi().list('learning')) as Array<Record<string, unknown>>
    const planRecords = (await getDataApi().list('plan')) as Array<Record<string, unknown>>
    const { summary } = unlinkLearningTopic(selected.topic.id, learningRecords, planRecords)
    setDeleteSummary(summary)
    setDeleteOpen(true)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!selected) return
    const id = selected.topic.id
    await learning.removeTopicWithUnlink(id)
    setSelectedId(null)
    setEnteredTopicId(null)
    setDeleteOpen(false)
    notify('已删除，可在「数据与设置 → 回收站」里恢复')
  }

  /**
   * 记一次学习（主入口）。
   *
   * 保存走 `useSaveState`：成功才清空并关抽屉，**失败时正文原样留着**
   * ——让用户重打一遍是最不能接受的一种"失败处理"。
   */
  const onSaveLog = async (): Promise<void> => {
    if (!selected) return
    const normalized = normalizeRichText(logDraft.text, logDraft.format)
    if (normalized.text === '') return
    await logSave.run(() =>
      learning.addLog({
        topicId: selected.topic.id,
        date: dateKey(new Date()),
        minutes: clampMinutes(logMinutes),
        content: normalized.text,
        ...(normalized.contentFormat ? { contentFormat: normalized.contentFormat } : {})
      })
    )
    // 失败时保留输入（判断用 logSave.failed，不看返回值——见 lib/saveState.ts 文件头）
    if (logSave.failed) return
    setLogDraft(EMPTY_LOG_DRAFT)
    setLogDrawerOpen(false)
    notify('已记一次学习')
  }

  const onSaveResource = async (): Promise<void> => {
    if (!selected || resourceName.trim() === '') return
    const percent = resourcePercent.trim() === '' ? undefined : clampShare(resourcePercent)
    await learning.addNode({
      ownerId: selected.topic.id,
      parentId: null,
      title: resourceName.trim(),
      resourceType: resourceType.trim() === '' ? '资料' : resourceType.trim(),
      group: resourceGroup.trim(),
      note: resourceProgress.trim(),
      ...(percent !== undefined ? { percent } : {})
    })
    setResourceName('')
    setResourceGroup('')
    setResourceProgress('')
    setResourcePercent('')
    setResourceDrawerOpen(false)
    notify('已添加资料')
  }

  // ---------------------------------------------------------------------
  // 树的操作（第 02 块）：增 / 删 / 改 / 排序 / 折叠 / 打勾
  // ---------------------------------------------------------------------

  /** 新增节点：`parent.id === ''` 表示新增一份资料（根节点） */
  const onAddNode = (parent: TreeViewItem): void => {
    if (!selected) return
    if (parent.id === '') {
      // 资料是根节点，走「添加资料」抽屉（名称 / 分组 / 类型 / 当前进度 / 占比）
      setResourceName('')
      setResourceType('书')
      setResourceGroup('')
      setResourceProgress('')
      setResourcePercent('')
      setResourceDrawerOpen(true)
      return
    }
    const node = topicNodes.find((candidate) => candidate.id === parent.id) ?? null
    setNodeParent(node)
    setNodeTitleDraft('')
    setNodeDrawerOpen(true)
  }

  const onSaveNewNode = async (): Promise<void> => {
    if (!selected || nodeParent === null || nodeTitleDraft.trim() === '') return
    const createdId = await learning.addNode({
      ownerId: selected.topic.id,
      parentId: nodeParent.id,
      title: nodeTitleDraft.trim()
    })
    void createdId
    setNodeDrawerOpen(false)
    setNodeUi((current) => setExpanded(current, nodeParent.id, true))
    notify(`已在「${nodeParent.title}」下新增子节点`)
  }

  const onToggleNodeDone = async (item: TreeViewItem, done: boolean): Promise<void> => {
    // 树上的勾**只表示"这段学完"**：这里不许顺带改主题状态（决定 30 / R4）
    await learning.toggleNodeDone(item.id, done)
  }

  /** 就地改占比：填任意正数，程序自动归一化（§5.2 / §6.5） */
  const saveShare = async (node: LearningNode, raw: string): Promise<void> => {
    const trimmed = raw.trim()
    const share = clampShare(trimmed)
    if (trimmed !== '' && share === undefined) {
      notify('占比要填一个不小于 0 的数字')
      setShareEdit(null)
      return
    }
    if (trimmed === '' || share === undefined || share === 0) {
      await learning.updateNode(node.id, { percent: 0 })
    } else {
      await learning.updateNode(node.id, { percent: share })
    }
    setShareEdit(null)
    notify('已更新占比')
  }

  const onSaveRenameNode = async (values: FormValues): Promise<void> => {
    if (!renaming) throw new Error('没有要改名的节点')
    const title = (values['title'] ?? '').trim()
    if (title === '') throw new Error('名称不能为空')
    await learning.updateNode(renaming.id, { title })
    notify('已改名')
  }

  /** 移动节点：跨主题 / 移到自己的子节点下都会被 `tree.ts` 拒绝 */
  const onMoveNode = async (
    dragId: string,
    target: { parentId: string | null; index: number }
  ): Promise<void> => {
    const reason = await learning.moveTreeNode(dragId, target.parentId, target.index)
    if (reason !== null) notify(`不能移动：${reason}`)
    else notify('已调整位置')
  }

  /** 删除节点：先解除关联再删（走 unlink.ts），删除后可在回收站恢复 */
  const confirmDeleteNode = async (): Promise<void> => {
    if (!nodeDelete) return
    const summary = await learning.removeNodeWithUnlink(nodeDelete.id)
    setNodeDelete(null)
    notify(`已删除（${summary}）`)
  }

  /**
   * 树行的菜单项（右键挂点）。
   *
   * **不在这里写菜单项内容**：层级语义（是不是汇总节点、能不能展开、往哪挪）
   * 全由 `TreeView` 的 `actions` 算好，这里只是把它翻译成
   * `shared/contextMenu.ts` 里的那一份定义。
   */
  const treeMenuItems = (
    item: TreeViewItem,
    actions: TreeMenuActions
  ): ReturnType<typeof toSpecs> => {
    const node = topicNodes.find((candidate) => candidate.id === item.id)
    return toSpecs(
      treeNodeMenuFromActions(item, actions, {
        expanded: isExpanded(nodeUi, item.id),
        // 资料行：改占比（填任意正数，程序自动归一化）
        onEditMeasure: () => {
          if (!node) return
          setShareEdit({
            id: node.id,
            value: node.percent === undefined ? '' : String(node.percent)
          })
        },
        // 章 / 子章：改"读到哪了"的进度说明（写回 `note`）
        onEditNote: () => {
          if (!node) return
          setNoteDraft(node.note ?? '')
          setNoteEdit(node)
        }
      })
    )
  }

  /** 记一次学习：可以挂在具体章节上（决定 16）；正文是富文本（第 04 块） */
  const onLogToNode = async (nodeId: string, text: string, format: ContentFormat): Promise<void> => {
    if (!selected) return
    const normalized = normalizeRichText(text, format)
    if (normalized.text === '') return
    await learning.addLog({
      topicId: selected.topic.id,
      nodeId,
      date: dateKey(new Date()),
      minutes: clampMinutes(nodeLogMinutes),
      content: normalized.text,
      ...(normalized.contentFormat ? { contentFormat: normalized.contentFormat } : {})
    })
    notify('已记一次学习')
  }

  /**
   * 树的调试挂点：把**当前这棵树真实的移动函数**交给验收，
   * 好让"跨主题移动被拒"这条能在真实运行的程序里验一遍
   * （这条在界面上做不出来——页面只渲染当前主题的树）。
   */
  useTreeDebug({
    ownerId: selected?.topic.id ?? '',
    items: topicNodes,
    loadNodeIds: async (module) => {
      const records = (await getDataApi().listAlive(module)) as Array<Record<string, unknown>>
      return records.filter((item) => item['kind'] === 'node').map((item) => String(item['id'] ?? ''))
    },
    canMove: (dragId, parentId) =>
      canMove(
        topicNodes.map((node) => ({
          id: node.id,
          ownerId: node.ownerId,
          parentId: node.parentId,
          order: node.order
        })),
        dragId,
        parentId
      ),
    tryMove: (dragId, parentId, index) => learning.moveTreeNode(dragId, parentId, index)
  })

  /** 日志 → 复习卡（学习与复习之间唯一的联动） */
  const onLogToReview = async (logId: string): Promise<void> => {
    const log = allTopicLogs.find((item) => item.id === logId)
    if (!log || !selected) return
    const card = logToCard(log, selected.topic.title)
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

  /** 日志挂在哪一章上（挂在主题上的旧日志返回空串） */
  const logNodeTitle = (log: { nodeId?: string }): string => {
    const nodeId = log.nodeId ?? ''
    if (nodeId === '') return ''
    return topicNodes.find((node) => node.id === nodeId)?.title ?? ''
  }

  /**
   * 中区两块卡片（§6.3 / §7.1：固定 132px，**各自内部滚**）。
   *
   * 抽成两个变量而不是直接写进 JSX：卡片要排在"上预览"之后、"下树"之前，
   * 而这两块的数据（资料、学习日志）都是在这里才算得出来的。
   */
  /**
   * 中区「资料」卡里一行的菜单项（2026-10 修订）。
   *
   * **不在这里写菜单项内容**：`resourceRowMenuItems` 只是把这一行的字段翻成
   * `shared/contextMenu.ts` 里 `treeNodeMenuItems` 要的上下文——
   * 所以中区这一行与树里资料行取到的是**同一批项**（编辑 / 改占比 / 加子节点 /
   * 标记完成 / 删除…），删除也仍然走 `unlink` → 二次确认 → 回收站。
   */
  const resourceRowItems = (resource: LearningNode): MenuItemSpec[] => {
    const hasChildren = topicNodes.some((candidate) => candidate.parentId === resource.id)
    return toSpecs(
      resourceRowMenuItems({
        title: resource.title,
        done: resource.done,
        hasChildren,
        expanded: isExpanded(nodeUi, resource.id),
        onAddChild: () =>
          onAddNode({
            id: resource.id,
            parentId: resource.parentId,
            order: resource.order,
            title: resource.title,
            done: resource.done
          }),
        onRename: () => {
          setRenameDraft(resource.title)
          setRenaming(resource)
        },
        onDelete: () => setNodeDelete(resource),
        // 与树里的勾同一个动作：只表示"这段学完"，**不动主题状态**（决定 30 / R4）
        onToggleDone: () => void learning.toggleNodeDone(resource.id, !resource.done),
        onToggleExpand: () => setNodeUi((current) => toggleExpanded(current, resource.id)),
        onEditMeasure: () =>
          setShareEdit({
            id: resource.id,
            value: resource.percent === undefined ? '' : String(resource.percent)
          }),
        onEditNote: () => {
          setNoteDraft(resource.note ?? '')
          setNoteEdit(resource)
        }
      })
    )
  }

  const resourcesCard = (
    <BandCard
      title="资料"
      count={topicResources.length}
      testId="learning-resources-card"
      empty="还没有资料。点上面的「添加资料」或在树里「+新增资料」。"
    >
      <ul className="band-list">
        {topicResources.map((resource) => (
          <li
            key={resource.id}
            className="band-list__row"
            data-testid="learning-resource-row"
            data-resource-id={resource.id}
            // 右键也能出菜单（与 `⋯` 取同一批项，第 03 块的规矩）
            onContextMenu={(event) => {
              event.preventDefault()
              menu.openFromEvent(event, resourceRowItems(resource), `resource-row:${resource.id}`)
            }}
          >
            <span className="band-list__title">{resource.title}</span>
            {/* 这一块只写「分组 · 类型 · 占比」；两个数字（占比 / 已学）在树里的资料行上 */}
            <span className="band-list__tail">
              <span className="band-list__meta" data-testid="learning-resource-meta">
                {resourceCardMeta(resource, topicNodes)}
              </span>
              <MenuButton
                menu={menu}
                items={() => resourceRowItems(resource)}
                testId="learning-resource-menu"
                className="row-menu-button"
                label="这份资料的更多操作"
              />
            </span>
          </li>
        ))}
      </ul>
    </BandCard>
  )

  const logsCard = (
    <BandCard
      title="学习日志"
      count={allTopicLogs.length}
      testId="learning-logs"
      empty="还没有学习记录。点上面的「记一次学习」。"
    >
      <ul className="log-list">
        {allTopicLogs.map((log) => {
          const nodeTitle = logNodeTitle(log)
          return (
            <li
              key={log.id}
              className="log"
              data-testid="learning-log"
              data-log-id={log.id}
              data-node-id={log.nodeId ?? ''}
            >
              <div className="log__head">
                <span className="log__date">{log.date}</span>
                <span className="log__minutes">{log.minutes} 分钟</span>
                {nodeTitle === '' ? null : (
                  <span className="log__node" data-testid="learning-log-node">
                    挂在「{nodeTitle}」
                  </span>
                )}
                <button
                  type="button"
                  className="link"
                  data-testid="learning-log-to-review"
                  onClick={() => void onLogToReview(log.id)}
                >
                  → 复习
                </button>
                <button
                  type="button"
                  className="link link--danger"
                  data-testid="learning-log-delete"
                  onClick={() => void learning.removeLog(log.id)}
                >
                  删除
                </button>
              </div>
              <RichTextView
                value={log.content}
                format={log.contentFormat}
                className="log__content"
                testId="learning-log-text"
              />
            </li>
          )
        })}
      </ul>
    </BandCard>
  )

  return (
    <PageShell
      title="学习"
      /*
        内容区吃满剩余高度 + **下区跟随整页滚**（2026-10 修订 · `MASTER.md` §7.2 / 决定 7）：
        滚动发生在右侧内容区（`.workspace`），下区按内容高、不再在小框里滚。
      */
      fill
      scroll
      description={
        selected
          ? `${visible.length} 个主题 · 当前：${selected.topic.title}${entered ? ' · 已进入主题' : ''}`
          : '还没有学习主题'
      }
      primaryAction={{
        label: '新主题',
        testId: 'learning-new-topic',
        onClick: () => {
          // 与热键 N 同一个动作：把焦点放到行内输入框
          focusByTestId('learning-new-topic-input')
        }
      }}
      toolbar={
        <>
          {/*
            新建主题的行内输入放在工具条这一行里（而不是再占一整行）：
            学习页的纵向空间要留给"上预览 / 中两块 / 下树"三段，
            多一行就是树少一行（§7.2 的滚轮规矩：页面不滚，谁多占谁挤别人）。
          */}
          <InlineInput
            placeholder="新建学习主题…（回车创建）"
            hint="已创建"
            testId="learning-new-topic-input"
            onSubmit={onAddTopic}
          />
          <button
            type="button"
            className={`chip${showArchived ? ' chip--active' : ''}`}
            data-testid="learning-toggle-archived"
            onClick={() => setShowArchived((value) => !value)}
          >
            显示已归档
          </button>
          <span className="toolbar__spacer" />
        </>
      }
    >
      {learning.error ? <p className="notice notice--error">读取失败：{learning.error}</p> : null}
      {flash ? (
        <p className="notice notice--ok" data-testid="learning-flash">
          {flash}
        </p>
      ) : null}

      {/*
        左栏中段：当前模块的条目列表（§7.1 的骨架里那一段"列表 ↕滚轮"）。
        列表用 portal 塞进侧栏，但数据、选中状态、点击行为**都留在这一页**——
        外壳不需要认识"学习主题"是什么（见 shell/SidebarSlot.tsx）。
      */}
      <SidebarListPortal>
        <div className="sidebar-list" data-testid="learning-topics">
          <div className="sidebar-list__head">
            <span>主题</span>
            <span>{visible.length}</span>
          </div>
          {visible.length === 0 ? (
            <p className="sidebar-list__empty" data-testid="learning-empty">
              还没有学习主题，上面新建一个。
            </p>
          ) : (
            <ul className="topic-list">
              {visible.map(({ topic }) => {
                const meta = listMeta(topic.id)
                const active = selected?.topic.id === topic.id
                return (
                  <li key={topic.id}>
                    <button
                      type="button"
                      className={`topic${active ? ' topic--active' : ''}`}
                      data-testid="learning-topic"
                      data-topic-id={topic.id}
                      data-status={topic.status}
                      data-active={active ? '1' : '0'}
                      data-percent={meta.percent}
                      data-resource-count={meta.resourceCount}
                      data-total-minutes={meta.totalMinutes}
                      onClick={() => {
                        setSelectedId(topic.id)
                        // 换主题 = 回到"未进入"那一步（同一个主题再点一次不动）
                        setEnteredTopicId((current) => (current === topic.id ? current : null))
                      }}
                    >
                      <span className="topic__title">{topic.title}</span>
                      {/* 名字 / 进度% / 资料数 / 时长（§6.1）；进度是占比加权算出来的 */}
                      <span className="topic__meta" data-testid="learning-topic-meta">
                        {topicListMetaText(meta)}
                      </span>
                      {topic.status !== 'active' ? (
                        <span className="topic__tag">{TOPIC_STATUS_LABELS[topic.status]}</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SidebarListPortal>

      {/* 三段骨架：上预览 / 中两块 / 下树（§7.1；预览与卡片不整页替换，决定 1） */}
      <ModuleBands
        testId="learning-bands"
        cards={[resourcesCard, logsCard]}
        preview={
          !selected ? (
            <EmptyState message="左侧选一个主题，或先新建一个。" testId="learning-detail-empty" />
          ) : (
            <div className="preview" data-testid="learning-detail">
              {/* 左：这个主题是什么（§6.2 左侧信息：说明 / 开始 / 时限 / 资料数 / 记录数） */}
              <section className="preview__info" data-testid="learning-info">
                <header className="detail__head">
                  <h2 className="detail__title" data-testid="learning-detail-title">
                    {selected.topic.title}
                  </h2>
                  <span className="detail__badge" data-testid="learning-detail-status">
                    {TOPIC_STATUS_LABELS[selected.topic.status]}
                  </span>
                </header>
                <p className="preview__desc" data-testid="learning-detail-description">
                  {selected.topic.description === undefined || selected.topic.description === ''
                    ? '还没有填说明。点「编辑」可以补上。'
                    : selected.topic.description}
                </p>
                <dl className="preview__facts">
                  <div className="preview__fact">
                    <dt>开始</dt>
                    <dd data-testid="learning-fact-started">{previewFacts?.startedAt || '—'}</dd>
                  </div>
                  <div className="preview__fact">
                    <dt>时限</dt>
                    <dd data-testid="learning-fact-time-limit">{previewFacts?.timeLimit}</dd>
                  </div>
                  <div className="preview__fact">
                    <dt>资料</dt>
                    <dd data-testid="learning-fact-resources">{previewFacts?.resourceCount} 项</dd>
                  </div>
                  <div className="preview__fact">
                    <dt>学习记录</dt>
                    <dd data-testid="learning-fact-records">{previewFacts?.recordText}</dd>
                  </div>
                </dl>
              </section>

              {/* 右：进度（占比加权）+ 按钮排（§6.2） */}
              <section className="preview__main" data-testid="learning-preview-main">
                <div className="progress" data-testid="learning-progress">
                  <div
                    className="progress__bar"
                    title="主题进度 ＝ Σ(资料占比 × 资料内部完成度) ÷ Σ占比（占比自动归一化）"
                  >
                    <div
                      className="progress__fill"
                      style={{ width: `${computedTopicProgress}%` }}
                      data-testid="learning-progress-fill"
                    />
                    {marks.map((mark) => (
                      <span
                        key={mark.date}
                        className="progress__mark"
                        title={`${mark.date}：${mark.minutes} 分钟`}
                      />
                    ))}
                  </div>
                  <div className="progress__row">
                    <span className="progress__value" data-testid="learning-progress-computed">
                      {computedTopicProgress}%
                    </span>
                    <span className="progress__auto">
                      ＝ Σ(占比 × 内部完成度) ÷ Σ占比
                    </span>
                    <span className="toolbar__spacer" />
                    {/* 手动那一档（02 块就有）：只作参考，进度条与主题行都按树算 */}
                    <span className="progress__auto">手动</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={selected.topic.progress}
                      data-testid="learning-progress-range"
                      onChange={(event) =>
                        void learning.updateTopic(selected.topic.id, {
                          progress: clampProgress(event.target.value)
                        })
                      }
                    />
                    <span className="progress__value" data-testid="learning-progress-value">
                      {selected.topic.progress}%
                    </span>
                    <button
                      type="button"
                      className="button"
                      data-testid="learning-advance-by-tree"
                      onClick={() => {
                        void learning
                          .updateTopic(selected.topic.id, { progress: computedTopicProgress })
                          .then(() => notify(`进度已按资料算到 ${computedTopicProgress}%`))
                      }}
                    >
                      按资料推进
                    </button>
                  </div>
                </div>

                <div className="detail__actions">
                  {/* 三步走的第二步入口：进／退都是它（决定 1、R2） */}
                  <button
                    type="button"
                    className="button button--primary"
                    data-testid="learning-enter-topic"
                    data-entered={entered ? '1' : '0'}
                    onClick={() => setEnteredTopicId(entered ? null : selected.topic.id)}
                  >
                    {entered ? '退出主题' : '进入主题'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="learning-log-study"
                    onClick={() => setLogDrawerOpen(true)}
                  >
                    记一次学习
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="learning-edit-topic"
                    onClick={() => {
                      setEditInitial({
                        title: selected.topic.title,
                        description: selected.topic.description ?? '',
                        targetDays:
                          selected.topic.targetDays === undefined
                            ? ''
                            : String(selected.topic.targetDays)
                      })
                      setEditOpen(true)
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="learning-add-resource"
                    onClick={() => {
                      setResourceName('')
                      setResourceType('书')
                      setResourceGroup('')
                      setResourceProgress('')
                      setResourcePercent('')
                      setResourceDrawerOpen(true)
                    }}
                  >
                    添加资料
                  </button>
                  {/*
                    状态按钮**按当前状态条件显示**（修改 4 轮 §6.1 的矩阵）。
                    以前这里是两个无条件按钮、目标状态写死在 onClick 里，于是
                    "标记完成不能取消"、"归档和标记完成同时出现"（用户原话）。
                    现在目标状态由 `topicStatusActions()` 算出来，一格一字都不写死。
                  */}
                  {topicStatusActions(selected.topic.status).map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className="button"
                      data-testid={action.id}
                      data-target-status={action.target}
                      onClick={() => void learning.updateTopic(selected.topic.id, { status: action.target })}
                    >
                      {action.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="button is-danger"
                    data-testid="learning-delete-topic"
                    onClick={() => void prepareDelete()}
                  >
                    删除
                  </button>
                </div>
              </section>
            </div>
          )
        }
      >
        {/* 下：资料与章节树。**进入主题之后**才展开（决定 1 / §6.6） */}
        {!selected ? (
          <EmptyState
            message="在左边选一个主题，这一块就是它的资料与章节树。"
            testId="learning-tree-hint"
          />
        ) : !entered ? (
          <section className="panel panel--hint" data-testid="learning-tree-locked">
            <p className="panel__hint">
              点上面「进入主题」，下方就会展开这个主题的资料与章节。
              （资料为根；占比你自己设，已学按最小单元算）
            </p>
          </section>
        ) : (
          <section className="panel" data-testid="learning-resources">
            <header className="panel__head">
              <h3 className="panel__title">
                资料与章节（{topicResources.length} 份资料 · {topicNodes.length} 个节点）
              </h3>
              <span className="panel__note">
                点资料行可改占比；虚线框是汇总节点，不参与计数
              </span>
            </header>
            <TreeView
              ownerId={selected.topic.id}
              items={topicNodes}
              testIdPrefix="learning-tree"
              addRootLabel="加资料"
              emptyHint="还没有资料。点「加资料」建第一份，再在它下面加章节。"
              loading={learning.loading}
              error={learning.error}
              expandedIds={nodeUi.expandedIds}
              // 就地面板**单独一份**状态（2026-10 修订）：与子节点展开解耦
              openDetailIds={openDetailIdsOf(nodeUi)}
              onToggleExpand={(item, next) =>
                setNodeUi((current) => setExpanded(current, item.id, next))
              }
              onOpenDetail={(item) => {
                // 点资料行 → 就地改占比；点章节 → 就地展开它的学习记录
                if (item.parentId === null) {
                  const node = topicNodes.find((candidate) => candidate.id === item.id)
                  if (node) {
                    setShareEdit({
                      id: node.id,
                      value: node.percent === undefined ? '' : String(node.percent)
                    })
                  }
                  return
                }
                // 只改面板状态：**不再动** `expandedIds`
                // （点同一行收起、点另一行换过去，都由 nodePanel 那一个函数保证）
                setNodeUi((current) => toggleOpenPanel(current, item.id))
              }}
              badgeOf={(item) => {
                const node = topicNodes.find((candidate) => candidate.id === item.id)
                if (node === undefined || node.parentId !== null) return null
                const label = resourceLabel(node)
                return label === '' ? null : label
              }}
              // 资料行两个数字（占比 / 已学），其它行只有已学：口径在 shared/learningPageView
              progressOf={(item) => rowProgressText(item.id, topicNodes)}
              onToggleDone={(item, done) => void onToggleNodeDone(item, done)}
              onAddChild={onAddNode}
              onRename={(item) => {
                const node = topicNodes.find((candidate) => candidate.id === item.id)
                if (!node) return
                setRenameDraft(node.title)
                setRenaming(node)
              }}
              onDelete={(item) => {
                const node = topicNodes.find((candidate) => candidate.id === item.id)
                if (node) setNodeDelete(node)
              }}
              onMove={(dragId, target) => void onMoveNode(dragId, target)}
              // 第 03 块：右键菜单。菜单项内容来自 shared/contextMenu.ts 的
              // 唯一一份定义（行尾 `⋯` 与右键取到的是同一批项）。
              onContextMenuItems={(item, actions, event) => {
                const items = treeMenuItems(item, actions)
                setPendingMenu({
                  point: { x: event.clientX, y: event.clientY },
                  items,
                  source: `tree-row:${item.id}`
                })
                return items
              }}
              onMenuItems={(item, actions) => treeMenuItems(item, actions)}
              onRequestMenu={(item, actions, point) =>
                setPendingMenu({
                  point,
                  items: treeMenuItems(item, actions),
                  source: `tree-menu:${item.id}`
                })
              }
              nodeContent={(item) => {
                const nodeLogs = logsOfNode(item.id)
                return (
                  <div className="tree__logbox" data-testid="learning-node-detail">
                    {/*
                      面板右上角的「收起」（2026-10 修订）。
                      以前面板没有任何收起入口——用户只能猜"再点这一行"。
                      这里给一个**明确可见**的按钮，同时"再点这一行"也仍然能收
                      （两个入口都通），读书页用的是同一个位置、同一种文案。
                    */}
                    <div className="tree__detail-head">
                      <span className="panel__hint">这一节的学习记录</span>
                      <span className="toolbar__spacer" />
                      <button
                        type="button"
                        className="link"
                        data-testid="learning-node-panel-collapse"
                        title="收起这一块（与再点一次这一行、按 Esc 都是同一个动作）"
                        onClick={() => setNodeUi((current) => closeOpenPanel(current))}
                      >
                        收起
                      </button>
                    </div>
                    <div className="preset-row">
                      {MINUTE_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`chip${nodeLogMinutes === preset ? ' chip--active' : ''}`}
                          data-testid={`learning-node-minutes-${preset}`}
                          onClick={() => setNodeLogMinutes(preset)}
                        >
                          {preset} 分钟
                        </button>
                      ))}
                    </div>
                    <RichTextComposer
                      testId="learning-node-log-input"
                      placeholder={`记一次学习（挂在「${item.title}」上，回车保存）`}
                      submitKey="enter"
                      minHeight={88}
                      onSubmit={(text, format) => onLogToNode(item.id, text, format)}
                    />
                    {nodeLogs.length === 0 ? (
                      <p className="panel__hint">这一节还没有学习记录。</p>
                    ) : (
                      <ul className="log-list">
                        {nodeLogs.map((log) => (
                          <li key={log.id} className="log" data-testid="learning-node-log">
                            <div className="log__head">
                              <span className="log__date">{log.date}</span>
                              <span className="log__minutes">{log.minutes} 分钟</span>
                              <button
                                type="button"
                                className="link"
                                data-testid="learning-node-log-review"
                                onClick={() => void onLogToReview(log.id)}
                              >
                                → 复习
                              </button>
                              <button
                                type="button"
                                className="link link--danger"
                                onClick={() => void learning.removeLog(log.id)}
                              >
                                删除
                              </button>
                            </div>
                            {/* 按 contentFormat 渲染：旧日志（无此字段）走纯文本，显示不变 */}
                            <RichTextView
                              value={log.content}
                              format={log.contentFormat}
                              className="log__content"
                              testId="learning-node-log-text"
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              }}
            />
            {/* 就地改占比（§6.5：点资料行 → 填任意数字，自动归一化） */}
            {shareEdit === null ? null : (
              <div className="inline-row" data-testid="learning-share-editor">
                <span className="panel__hint">占比（随便填，程序自动归一化）</span>
                <input
                  className="field__control field__control--short"
                  type="number"
                  min={0}
                  value={shareEdit.value}
                  data-testid="learning-share-input"
                  onChange={(event) =>
                    setShareEdit({ id: shareEdit.id, value: event.target.value })
                  }
                />
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="learning-share-save"
                  onClick={() => {
                    const node = topicNodes.find((candidate) => candidate.id === shareEdit.id)
                    if (node) void saveShare(node, shareEdit.value)
                  }}
                >
                  保存占比
                </button>
                <button
                  type="button"
                  className="button"
                  data-testid="learning-share-cancel"
                  onClick={() => setShareEdit(null)}
                >
                  取消
                </button>
              </div>
            )}
          </section>
        )}
      </ModuleBands>

      {/* 记一次学习 */}
      <Drawer
        open={logDrawerOpen}
        title="记一次学习"
        onClose={() => setLogDrawerOpen(false)}
        testId="learning-log-drawer"
        footer={
          <div className="form__footer">
            {/* 保存三态必须可见（第 04 块：新增的编辑区都要接） */}
            <SaveHint save={logSave} testId="learning-log-save-state" />
            <span className="toolbar__spacer" />
            <button
              type="button"
              className="button button--primary"
              data-testid="learning-log-save"
              disabled={logSave.state === 'saving'}
              onClick={() => void onSaveLog()}
            >
              保存
            </button>
          </div>
        }
      >
        <div className="field">
          <span className="field__label">时长</span>
          <div className="preset-row">
            {MINUTE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`chip${logMinutes === preset ? ' chip--active' : ''}`}
                data-testid={`learning-minutes-${preset}`}
                onClick={() => setLogMinutes(preset)}
              >
                {preset} 分钟
              </button>
            ))}
            <input
              className="field__control field__control--short"
              type="number"
              min={0}
              max={1440}
              value={logMinutes}
              data-testid="learning-minutes-input"
              onChange={(event) =>
                setLogMinutes(Math.max(0, Number.parseInt(event.target.value || '0', 10)))
              }
            />
          </div>
        </div>
        <div className="field">
          <span className="field__label">这次做了什么</span>
          <RichText
            value={logDraft.text}
            format={logDraft.format}
            placeholder="例如：读完第 3 章，做了 10 道例句练习（可以用工具条加粗、分点）"
            testId="learning-log-content"
            minHeight={120}
            onChange={(text, format) => setLogDraft({ text, format })}
          />
        </div>
      </Drawer>

      {/* 添加资料：名称 + 分组名 + 类型 + 当前进度 + 占比（§6.5） */}
      <Drawer
        open={resourceDrawerOpen}
        title="添加资料"
        onClose={() => setResourceDrawerOpen(false)}
        testId="learning-resource-drawer"
        footer={
          <button
            type="button"
            className="button button--primary"
            data-testid="learning-resource-save"
            onClick={() => void onSaveResource()}
          >
            保存
          </button>
        }
      >
        <label className="field">
          <span className="field__label">名称</span>
          <input
            className="field__control"
            value={resourceName}
            placeholder="例如：《语法俱乐部》"
            data-testid="learning-resource-name"
            onChange={(event) => setResourceName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">分组名（自己填）</span>
          <input
            className="field__control"
            value={resourceGroup}
            placeholder="例如：教材 / 参考 / 习题"
            data-testid="learning-resource-group"
            onChange={(event) => setResourceGroup(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">类型</span>
          <input
            className="field__control"
            value={resourceType}
            placeholder="书 / 视频 / 课程 / 文档"
            data-testid="learning-resource-type"
            onChange={(event) => setResourceType(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">当前进度</span>
          <input
            className="field__control"
            value={resourceProgress}
            placeholder="例如：第 3/10 章"
            data-testid="learning-resource-progress"
            onChange={(event) => setResourceProgress(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">占比（随便填，自动归一化）</span>
          <input
            className="field__control"
            type="number"
            min={0}
            value={resourcePercent}
            placeholder="例如 50；不填就按等权"
            data-testid="learning-resource-percent"
            onChange={(event) => setResourcePercent(event.target.value)}
          />
        </label>
      </Drawer>

      {/* 新增树节点（章节 / 子章 / 条目）——层数不限 */}
      <Drawer
        open={nodeDrawerOpen}
        title={nodeParent === null ? '新增节点' : `在「${nodeParent.title}」下新增`}
        onClose={() => setNodeDrawerOpen(false)}
        testId="learning-node-drawer"
        footer={
          <button
            type="button"
            className="button button--primary"
            data-testid="learning-node-save"
            onClick={() => void onSaveNewNode()}
          >
            保存
          </button>
        }
      >
        <label className="field">
          <span className="field__label">名称</span>
          <input
            className="field__control"
            value={nodeTitleDraft}
            placeholder="例如：1.1 位与字节"
            data-testid="learning-node-title"
            onChange={(event) => setNodeTitleDraft(event.target.value)}
          />
        </label>
        <p className="panel__hint">
          层数不限：在子节点上继续「+子节点」就能建到 1.1.1.1。第 5 层起缩进会自动收窄。
        </p>
      </Drawer>

      {/* 节点改名 */}
      <FormDrawer
        open={renaming !== null}
        title="重命名节点"
        fields={[
          {
            kind: 'text',
            key: 'title',
            label: '名称',
            required: true,
            testId: 'learning-node-rename-title'
          }
        ]}
        initialValues={{ title: renameDraft }}
        onClose={() => setRenaming(null)}
        onSubmit={onSaveRenameNode}
        testId="learning-node-rename-form"
      />

      {/* 改页码 / 进度说明（右键菜单里的那一项；写回节点的 `note`） */}
      <FormDrawer
        open={noteEdit !== null}
        title="改页码 / 进度说明"
        fields={[
          {
            kind: 'text',
            key: 'note',
            label: '读到哪了',
            placeholder: '例如：第 3/10 章 或 p.128',
            testId: 'learning-node-note-input'
          }
        ]}
        initialValues={{ note: noteDraft }}
        onClose={() => setNoteEdit(null)}
        onSubmit={async (values) => {
          if (!noteEdit) return
          await learning.updateNode(noteEdit.id, { note: (values['note'] ?? '').trim() })
          setNoteEdit(null)
          notify('已更新进度说明')
        }}
        testId="learning-node-note-form"
      />

      {/* 树行的右键菜单（`⋯` 与它取同一份定义） */}
      <ContextMenu state={menu.state} onClose={menu.close} />

      {/* 删除节点（连同子节点；走 unlink 规则） */}
      <ConfirmDialog
        open={nodeDelete !== null}
        title="删除这个节点？"
        message={
          <>
            <p data-testid="learning-node-delete-summary">
              「{nodeDelete?.title ?? ''}」连同它下面的全部子节点会一起删除。
            </p>
            <p>关联内容会解除关联但保留；删除后可在「数据与设置 → 回收站」里恢复。</p>
          </>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDeleteNode()}
        onCancel={() => setNodeDelete(null)}
        testId="learning-node-delete-dialog"
      />

      {/* 编辑主题（BUG-002；第 09 块补上「时限」） */}
      <FormDrawer
        open={editOpen}
        title="编辑学习主题"
        fields={[
          {
            kind: 'text',
            key: 'title',
            label: '主题',
            placeholder: '要学什么…',
            required: true,
            testId: 'learning-edit-title'
          },
          {
            kind: 'text',
            key: 'description',
            label: '说明',
            placeholder: '可留空',
            multiline: true,
            testId: 'learning-edit-description'
          },
          {
            kind: 'number',
            key: 'targetDays',
            label: '时限（天，可留空）',
            min: 0,
            testId: 'learning-edit-target-days'
          }
        ]}
        initialValues={editInitial}
        onClose={() => setEditOpen(false)}
        onSubmit={onSaveTopicEdit}
        testId="learning-edit-form"
      />

      {/* 删除确认（BUG-007）：明确说明关联内容会被保留 */}
      <ConfirmDialog
        open={deleteOpen}
        title="删除这个学习主题？"
        message={
          <>
            <p>仅删除当前主题，关联内容将解除关联但保留。</p>
            <p className="dialog__detail" data-testid="learning-delete-summary">
              {deleteSummary}
            </p>
            <p>删除后可在「数据与设置 → 回收站」里恢复。</p>
          </>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteOpen(false)}
        testId="learning-delete-dialog"
      />
    </PageShell>
  )
}

/** 供测试：主题排序规则（进行中 → 已完成 → 已归档） */
export function orderTopics(topics: LearningTopic[]): LearningTopic[] {
  return [...topics].sort((a, b) => {
    const order = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    if (order !== 0) return order
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  })
}
