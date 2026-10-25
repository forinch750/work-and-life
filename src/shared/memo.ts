/**
 * 备忘录的数据模型（PRD §5.6）
 *
 * 备忘一直是最"自由"的一类记录（`{ text, pinned }`），没有独立的类型文件。
 * v2 起它也要有标签与富文本，因此补一份**显式模型**——
 * 界面拿得到类型，磁盘上的旧记录却**一个字节都不用改**：
 *
 *   - `kind` 缺省即 `memo`（旧记录根本没有 kind 字段，不补写）
 *   - `tags` 缺省即空数组（不做"没有就写个 []"的批量改写）
 *   - `contentFormat` 缺省即 `plain`（旧正文是纯文本，零改写）
 */
import type { BaseRecord } from './types'
import type { ContentFormat } from './richText'
import { normalizeRichText, toPlainText } from './richText'

export interface MemoRecord extends BaseRecord {
  /** v1 的旧 record 没有这个字段，因此是可选；缺省即 'memo' */
  kind?: 'memo'
  /** 备忘正文 */
  text: string
  /** 置顶 */
  pinned?: boolean
  /** 标签（形状参考 Book.tags）；缺省即没有标签 */
  tags?: string[]
  /** 正文格式标记：缺省即 plain（旧数据零改写），新记录写 rich */
  contentFormat?: ContentFormat
}

/** 标签的规范化：去空、去重、保持原顺序 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/** 把任意记录规范成备忘（数据来自磁盘或导入文件，必须宽容） */
export function normalizeMemoRecord(input: Record<string, unknown>): MemoRecord | null {
  const id = String(input['id'] ?? '')
  if (id === '') return null
  const tags = normalizeTags(input['tags'])
  return {
    id,
    createdAt: String(input['createdAt'] ?? ''),
    updatedAt: String(input['updatedAt'] ?? ''),
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {}),
    text: String(input['text'] ?? ''),
    ...(input['pinned'] === true ? { pinned: true } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(input['contentFormat'] === 'rich' ? { contentFormat: 'rich' as const } : {})
  }
}

/** 按标签筛选（空标签集视为"不筛"，返回全部） */
export function filterByTag(memos: MemoRecord[], tag: string | null): MemoRecord[] {
  if (tag === null || tag === '') return memos
  return memos.filter((memo) => (memo.tags ?? []).includes(tag))
}

/**
 * 按**一组**标签筛选工具条（第 06 块 FEAT-004）。
 *
 * 语义定为"命中任意一个"（OR），不是"必须全中"：
 * 标签是给人"缩小范围"用的，选了 `工作` 和 `待办` 却一条都不显示，
 * 那是最容易让人以为"程序把我的备忘弄丢了"的行为。
 * 空数组 = 不筛（返回全部）。
 */
export function filterMemosByTags(memos: MemoRecord[], tags: string[]): MemoRecord[] {
  const wanted = normalizeTags(tags)
  if (wanted.length === 0) return memos
  const set = new Set(wanted)
  return memos.filter((memo) => (memo.tags ?? []).some((tag) => set.has(tag)))
}

/**
 * 现有标签的出现次数（工具条的筛选项）。
 *
 * 排序固定为"多的在前，同数量按名字"：顺序每次都一样，
 * 否则每存一条备忘，工具条上的标签就会自己换位置。
 */
export function tagCounts(memos: MemoRecord[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const memo of memos) {
    for (const tag of memo.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) =>
      a.count === b.count ? a.tag.localeCompare(b.tag, 'zh-Hans-CN') : b.count - a.count
    )
}

// ---------------------------------------------------------------------------
// 富文本消费侧（`docs\TASKS\04` §三 ②：四处依赖方一个都不能漏）
//
// 备忘的正文从第 04 块起可能是 HTML。凡是把它当**纯文本**用的地方——
// 转任务当标题、转复习卡当正面、复制到剪贴板、页内筛选、全局搜索——
// 都必须先过 `toPlainText`，否则标签会漏出去。
//
// 抽成函数而不是在页面里各写一遍：页面里的分支没人测得到，
// 这里的函数有单测钉住（`tests/data/richConsumers.test.ts`）。
// ---------------------------------------------------------------------------

/** 正文的纯文本：plain 原样返回，rich 先剥标签（旧记录走前者，行为不变） */
export function memoPlainText(memo: Pick<MemoRecord, 'text' | 'contentFormat'> | Record<string, unknown>): string {
  const record = memo as Record<string, unknown>
  return toPlainText(record['text'], record['contentFormat'])
}

/** 备忘 → 计划任务的落库字段（标题只取纯文本，绝不把标签当标题） */
export function memoToPlanInput(
  memo: Pick<MemoRecord, 'text' | 'contentFormat'> | Record<string, unknown>,
  todayKey: string
): Record<string, unknown> {
  return {
    title: memoPlainText(memo).trim(),
    date: todayKey,
    timeSlot: 'none',
    recurrence: 'none',
    done: false,
    carriedOver: 0,
    doneAt: null
  }
}

/**
 * 备忘 → 复习卡的落库字段。
 *
 * 正面同样只取纯文本：复习卡的正面要直接显示在卡片上，
 * 带一串 `<p>` `<b>` 既难看也没法背。
 */
export function memoToCardInput(
  memo: Pick<MemoRecord, 'text' | 'contentFormat'> | Record<string, unknown>,
  todayKey: string
): Record<string, unknown> {
  return {
    front: memoPlainText(memo).trim(),
    back: '',
    source: '备忘',
    stage: 0,
    dueDate: todayKey,
    reviewCount: 0,
    lastReviewedAt: null
  }
}

/**
 * 新建 / 编辑备忘时的落库形状。
 *
 * - `format` 缺省（纯文本编辑器写入的场合，例如快速记一笔）→ **不写** contentFormat，
 *   即按 plain 处理。这与旧记录的口径一致，也避免给每条备忘都补一个 `'plain'`。
 * - `'rich'` → 净化后连同 `contentFormat: 'rich'` 一起写。
 */
export function normalizeMemoText(
  text: unknown,
  format?: unknown
): { text: string; contentFormat?: ContentFormat } {
  return normalizeRichText(text, format)
}
