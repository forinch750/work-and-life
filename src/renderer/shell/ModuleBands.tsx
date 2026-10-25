/**
 * 三段骨架：上预览 / 中两块 / 下主体（第 08 块 · `MASTER.md` §7.1–§7.2）
 *
 * 学习、复习、读书三处**必须长得一样**（决定 1、7）：
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ 上：预览（名称 / 状态 / 进度 / 按钮排）    │  ← 按内容高，固定
 * ├──────────────────────────────────────────┤
 * │ 中：两块卡片（固定 132px，各自内部滚）     │  ← 固定高，各自滚
 * ├──────────────────────────────────────────┤
 * │ 下：主体（树 / 日历）                      │  ← **按内容高，随整页往下翻**
 * └──────────────────────────────────────────┘
 * ```
 *
 * **三步走**（决定 1）：选中条目 → 看预览（含中区两块）→ 点「进入…」→ 下方展开树。
 * 预览与卡片**保留在上面，不整页替换**——所以这三段是同一个布局里的三行，
 * 不是三个页面。
 *
 * 滚轮规矩全部落在 `styles/layout.css` 的 `.bands*` / `.band-card*` 上：
 * 中区两块固定高内部滚；**三模块页的下区与树按内容高**，滚动由右侧内容区承担
 * （2026-10 修订：用户要求"滚动整个页面时下区跟着往下翻"，见 `page--scroll` 一节）。
 * 09/10/11 三块请**直接用这两个组件 + 那两个 class 前缀**，别各写一遍。
 *
 * ## 09/10/11 怎么用
 *
 * ```tsx
 * <ModuleBands
 *   preview={<预览区：标题 + 状态 + 进度条 + 按钮排 />}
 *   cards={[
 *     <BandCard title="资料" count={resources.length} testId="learning-resources-card">…</BandCard>,
 *     <BandCard title="学习日志" count={logs.length} testId="learning-logs">…</BandCard>
 *   ]}
 * >
 *   <树 />
 * </ModuleBands>
 * ```
 *
 * 每一段都写了 `data-band` 属性，验收（`main/verify/phase8.ts`）
 * 靠它数"哪几段是内部滚的"。
 */
import type { ReactNode } from 'react'

/** 中区一块卡片：固定高度、标题固定、内容自己滚 */
export interface BandCardProps {
  title: string
  /** 右上角的计数（条数之类）；不传就不显示 */
  count?: number
  testId?: string
  /** 空列表时的提示文字 */
  empty?: string
  children: ReactNode
}

export function BandCard({
  title,
  count,
  testId,
  empty,
  children
}: BandCardProps): React.JSX.Element {
  const isEmpty = count === 0 && empty !== undefined
  return (
    <section className="band-card" data-testid={testId} data-band="card">
      <header className="band-card__head">
        <span className="band-card__title">{title}</span>
        {typeof count === 'number' ? (
          <span className="band-card__count" data-testid={testId ? `${testId}-count` : undefined}>
            {count}
          </span>
        ) : null}
      </header>
      {/* 这一层才是"内部滚动"的那一层：卡片固定 132px，内容再多也只在这里滚 */}
      <div className="band-card__body" data-testid={testId ? `${testId}-body` : undefined}>
        {isEmpty ? <p className="band-card__empty">{empty}</p> : children}
      </div>
    </section>
  )
}

export interface ModuleBandsProps {
  /** 上：预览 */
  preview: ReactNode
  /** 中：两块（可以是 0–2 个；通常两块） */
  cards: ReactNode[]
  /** 下：主体（树 / 日历主体）。三模块页**按内容高**，日历仍在主体内部滚 */
  children: ReactNode
  testId?: string
}

export function ModuleBands({
  preview,
  cards,
  children,
  testId = 'module-bands'
}: ModuleBandsProps): React.JSX.Element {
  return (
    <div className="bands" data-testid={testId} data-bands="1">
      <div className="bands__preview" data-band="preview" data-testid="bands-preview">
        {preview}
      </div>
      <div
        className="bands__cards"
        data-band="cards"
        data-testid="bands-cards"
        data-card-count={cards.length}
      >
        {cards.map((card, index) => (
          <div className="bands__card-slot" key={index} data-band="card-slot">
            {card}
          </div>
        ))}
      </div>
      <div className="bands__main" data-band="main" data-testid="bands-main">
        {children}
      </div>
    </div>
  )
}
