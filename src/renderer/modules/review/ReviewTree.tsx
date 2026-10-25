/**
 * 复习页的下区树：**资料 → 章节 → 卡片**（第 10 块 · `MASTER.md` §7.6 / 决定 18）
 *
 * 为什么另起一个组件、而不是套用 `shell/TreeView.tsx`：
 * 那一棵树管的是"可增删改名、可打勾、可拖拽"的**编辑**树；
 * 复习页的树是**复习**树——卡片是最小单元，行上要的是三色到期圆点、
 * 点一下就**就地展开背卡**（决定 18：不跳页、不进独立队列）。
 * 套用编辑树会带进一堆复习页用不上的按钮，还得给它们写假的回调。
 *
 * 行怎么算（层级、到期张数、卡片挂在哪）全部在 `shared/reviewPageView.ts`
 * 的 `reviewTreeRows()`（有单测）；本文件只负责渲染与交互，
 * 行为由端到端验收覆盖（`src\main\verify\phase8.ts` 的 P8-U5/U6/U7）。
 *
 * ## 与 06 块的衔接（**别另写一份评分逻辑**）
 *
 * 就地背卡的 DOM 与 testid 沿用 06 块那一套：
 * `inline-card-review` / `inline-card-front` / `inline-card-back` /
 * `inline-card-reveal` / `inline-card-grades` / `inline-grade-{forgot|fuzzy|remembered}`；
 * 评分动作由页面交给这里（页面里是 `writeGrade`：卡片 + 历史 + 裁剪三件事一起做）。
 */
import type { MouseEvent, ReactNode } from 'react'
import { indentForDepth } from '../../../shared/treeProgress'
import { GRADE_LABELS, intervalHintDays, type ReviewCard, type ReviewGrade } from '../../../shared/review'
import type { ReviewIntensity } from '../../../shared/preferences'
import { CARD_STATE_LABELS, type ReviewTreeRow } from '../../../shared/reviewPageView'

export interface ReviewTreeProps {
  rows: ReviewTreeRow[]
  /** 已折叠的资料 / 章节 id */
  collapsed: string[]
  onToggleCollapse: (nodeId: string) => void
  /** 就地展开的那张卡 */
  expandedCardId: string | null
  /** 那张卡是不是已经"显示答案" */
  revealed: boolean
  intensity: ReviewIntensity
  onToggleCard: (card: ReviewCard) => void
  onReveal: () => void
  onGrade: (card: ReviewCard, grade: ReviewGrade) => void
  /** 行尾 `⋯`（与右键同一批菜单项，由页面提供） */
  cardMenu: (card: ReviewCard) => ReactNode
  onContextMenu: (card: ReviewCard, event: MouseEvent<HTMLElement>) => void
}

export function ReviewTree({
  rows,
  collapsed,
  onToggleCollapse,
  expandedCardId,
  revealed,
  intensity,
  onToggleCard,
  onReveal,
  onGrade,
  cardMenu,
  onContextMenu
}: ReviewTreeProps): React.JSX.Element {
  /** 折叠一节之后，它下面的行（深度更大）一起收起来 */
  const visible = collapseRows(rows, collapsed)

  return (
    <ul className="review-tree" data-testid="review-tree" data-row-count={visible.length}>
      {visible.map((row) =>
        row.card === null ? (
          <li
            key={row.key}
            className={`review-tree__row review-tree__row--${row.kind}`}
            data-testid="review-node-row"
            data-node-id={row.id}
            data-kind={row.kind}
            data-depth={row.depth}
            data-due-count={row.dueCount}
            data-card-count={row.cardCount}
            data-collapsed={collapsed.includes(row.id) ? '1' : '0'}
            style={{ paddingLeft: `${8 + indentForDepth(row.depth)}px` }}
            onClick={() => onToggleCollapse(row.id)}
          >
            <span className="review-tree__caret" aria-hidden="true">
              {collapsed.includes(row.id) ? '▶' : '▼'}
            </span>
            <span className="review-tree__title">{row.title}</span>
            {row.badge === '' ? null : (
              <span className="review-tree__badge" data-testid="review-node-badge">
                {row.badge}
              </span>
            )}
            {/* 资料行写卡片张数（`4 张`），章节行不写 */}
            {row.kind === 'material' ? (
              <span className="review-tree__count" data-testid="review-node-count">
                {row.cardCount} 张
              </span>
            ) : null}
            <span className="toolbar__spacer" />
            <span
              className={`review-tree__due${row.dueCount === 0 ? ' review-tree__due--zero' : ''}`}
              data-testid="review-node-due"
            >
              {row.dueCount === 0 ? '已清' : `到期 ${row.dueCount}`}
            </span>
          </li>
        ) : (
          <CardRow
            key={row.key}
            row={row}
            expanded={row.card.id === expandedCardId}
            revealed={row.card.id === expandedCardId && revealed}
            intensity={intensity}
            onToggle={onToggleCard}
            onReveal={onReveal}
            onGrade={onGrade}
            cardMenu={cardMenu}
            onContextMenu={onContextMenu}
          />
        )
      )}
    </ul>
  )
}

/**
 * 折叠：节点行被折叠时，紧跟其后的更深层行全部收起来。
 *
 * 纯展示逻辑（不影响 `reviewTreeRows` 的算法），所以留在这个文件里。
 */
export function collapseRows(rows: ReviewTreeRow[], collapsed: string[]): ReviewTreeRow[] {
  const closed = new Set(collapsed)
  const out: ReviewTreeRow[] = []
  let hideBelow: number | null = null
  for (const row of rows) {
    if (hideBelow !== null) {
      if (row.depth > hideBelow) continue
      hideBelow = null
    }
    out.push(row)
    if (row.card === null && closed.has(row.id)) hideBelow = row.depth
  }
  return out
}

function CardRow({
  row,
  expanded,
  revealed,
  intensity,
  onToggle,
  onReveal,
  onGrade,
  cardMenu,
  onContextMenu
}: {
  row: ReviewTreeRow
  expanded: boolean
  revealed: boolean
  intensity: ReviewIntensity
  onToggle: (card: ReviewCard) => void
  onReveal: () => void
  onGrade: (card: ReviewCard, grade: ReviewGrade) => void
  cardMenu: (card: ReviewCard) => ReactNode
  onContextMenu: (card: ReviewCard, event: MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  const card = row.card as ReviewCard
  const state = row.state ?? 'later'
  return (
    <li
      // 06 块的就地背卡就是从这里点开的：testid 与 data-* 全部沿用，验收不必改口径
      className={`review-tree__row review-tree__row--card card-row${expanded ? ' card-row--open' : ''}`}
      data-testid="review-card-row"
      data-card-id={card.id}
      data-due={card.dueDate ?? ''}
      data-due-time={card.dueTime ?? ''}
      data-state={state}
      data-expanded={expanded ? '1' : '0'}
      data-depth={row.depth}
      style={{ paddingLeft: `${8 + indentForDepth(row.depth)}px` }}
      onClick={() => onToggle(card)}
      onContextMenu={(event) => onContextMenu(card, event)}
    >
      <div className="review-tree__line">
        {/* 圆点＝到期状态（🔴 今天到期 / 🟠 快到期 / 🟢 今天不用） */}
        <span
          className={`due-dot due-dot--${state}`}
          data-testid="review-card-state"
          data-state={state}
          title={CARD_STATE_LABELS[state]}
        />
        <span className="review-tree__title" data-testid="review-card-title">
          {card.front}
        </span>
        {/* 到期日 / 到期时间（06 块的 dueTime 显示在这里；两个都没有就整格不出现） */}
        {card.dueDate === null && card.dueTime === undefined ? null : (
          <span className="review-tree__time" data-testid="review-card-when">
            {card.dueDate === null ? '' : `到期 ${card.dueDate}`}
            {card.dueTime === undefined ? '' : ` ${card.dueTime}`}
          </span>
        )}
        <span className="toolbar__spacer" />
        <span
          className={`review-tree__due review-tree__due--${state}`}
          data-testid="review-card-state-label"
        >
          {CARD_STATE_LABELS[state]}
        </span>
        {/* 这一层拦住冒泡：点 `⋯` 不该顺带把卡片展开/收起 */}
        <span className="review-tree__actions" onClick={(event) => event.stopPropagation()}>
          {cardMenu(card)}
        </span>
      </div>

      {expanded ? (
        <div
          className="card-row__review"
          data-testid="inline-card-review"
          data-card-id={card.id}
          // 展开区里的点击（显示答案、评分）都不该把这一行收起来
          onClick={(event) => event.stopPropagation()}
        >
          <p className="inline-review__front" data-testid="inline-card-front">
            {card.front}
          </p>
          {revealed ? (
            <>
              <p className="inline-review__back" data-testid="inline-card-back">
                {card.back || '（这张卡没有写背面）'}
              </p>
              <div className="review__grades" data-testid="inline-card-grades">
                {(Object.keys(GRADE_LABELS) as ReviewGrade[]).map((value, index) => (
                  <button
                    key={value}
                    type="button"
                    className={`grade grade--${value}`}
                    data-testid={`inline-grade-${value}`}
                    onClick={() => onGrade(card, value)}
                  >
                    <span className="grade__label">{GRADE_LABELS[value]}</span>
                    <span className="grade__hint">{intervalHintDays(value, card.stage, intensity)} 天</span>
                    <span className="grade__key">{index + 1}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button
              type="button"
              className="button button--primary"
              data-testid="inline-card-reveal"
              onClick={onReveal}
            >
              显示答案（空格）
            </button>
          )}
          <p className="inline-review__hint">
            就地背卡：不会跳页、不会进队列。空格显示答案，1/2/3 评分。
          </p>
        </div>
      ) : null}
    </li>
  )
}
