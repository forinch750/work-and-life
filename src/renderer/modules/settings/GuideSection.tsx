/**
 * 「操作指南」分区（第 07 块 / `TASKS\07` §5.1 / §5.4）
 *
 * 位置：**「数据与设置」页里的一个独立分区**，不是新页面、不是新模块
 * （导航入口一个都没加）。
 *
 * 结构：**左侧章节目录 + 右侧正文**。目录点一下就把正文滚到那一章；
 * 正文滚动时目录跟着换选中项（`aria-current`），这样"我读到第几章"一眼看得见。
 *
 * 三条必须守住的界面规矩：
 *   - 正文里的键盘键渲染成 `<kbd>` 小标签（`shared\guide.ts` 的 `parseInline` 做判断），
 *     不是纯文本——这是指南里最需要"一眼看见"的东西
 *   - **正文区自己滚**：给固定高度 + `overflow-y: auto`，不许把设置页撑长
 *     （`MASTER.md` §7.2 的滚轮规矩）
 *   - 正文来自 `shared\guide.ts`（结构化数据），**不读任何运行时 md**、
 *     不引 Markdown 渲染器
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GUIDE,
  chapterTitle,
  parseInline,
  type GuideBlock,
  type GuideChapter
} from '../../../shared/guide'
import { chapterAt, scrollTopForChapter } from './guideScroll'

/** 正文块 → 界面。块类型只有这几种，所以这里是一个穷尽的分派。 */
function GuideBlockView({ block }: { block: GuideBlock }): React.JSX.Element {
  if (block.kind === 'subhead') {
    return <h4 className="guide__subhead">{block.title}</h4>
  }

  if (block.kind === 'paragraph') {
    return (
      <p className="guide__paragraph">
        {block.pending === true ? <PendingTag /> : null}
        <Inline text={block.text} />
      </p>
    )
  }

  if (block.kind === 'list') {
    const items = block.items.map((item, index) => (
      <li
        key={index}
        className={`guide__item${item.level === 1 ? ' guide__item--sub' : ''}`}
        data-testid="guide-item"
      >
        {item.pending === true ? <PendingTag /> : null}
        <Inline text={item.text} />
      </li>
    ))
    return block.ordered === true ? (
      <ol className="guide__list guide__list--ordered">{items}</ol>
    ) : (
      <ul className="guide__list">{items}</ul>
    )
  }

  if (block.kind === 'table') {
    return (
      <div className="guide__table-wrap">
        <table className="guide__table" data-testid="guide-table">
          <thead>
            <tr>
              {block.head.map((head) => (
                <th key={head}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} data-testid="guide-table-row">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.kind === 'code') {
    return (
      <pre className="guide__code-block">
        <code>{block.lines.join('\n')}</code>
      </pre>
    )
  }

  return (
    <blockquote className="guide__quote">
      <Inline text={block.text} />
    </blockquote>
  )
}

/**
 * 内联片段：`**加粗**` → `<strong>`，反引号 → 键盘键 `<kbd>` 或代码 `<code>`。
 *
 * 键与代码名共用反引号写法（正文里两者都这么写才自然），判据在
 * `shared\guide.ts` 的 `isKeyboardKey`——那里有单测，界面这里不再判断第二遍。
 */
function Inline({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseInline(text).map((token, index) => {
        if (token.kind === 'bold') return <strong key={index}>{token.text}</strong>
        if (token.kind === 'key') {
          return (
            <kbd key={index} className="guide__kbd" data-testid="guide-kbd">
              {token.text}
            </kbd>
          )
        }
        if (token.kind === 'code') {
          return (
            <code key={index} className="guide__inline-code">
              {token.text}
            </code>
          )
        }
        return <span key={index}>{token.text}</span>
      })}
    </>
  )
}

/** 【待实现】小标签（正文数据里用 `pending: true` 标，这里统一长相） */
function PendingTag(): React.JSX.Element {
  return (
    <span className="guide__pending" data-testid="guide-pending">
      【待实现】
    </span>
  )
}

/** 量出每一章在正文滚动容器里的纵向偏移（滚动联动与目录跳转共用） */
function chapterOffsets(body: HTMLElement): number[] {
  const base = body.getBoundingClientRect().top - body.scrollTop
  return Array.from(body.querySelectorAll<HTMLElement>('[data-guide-chapter]')).map(
    (element) => element.getBoundingClientRect().top - base
  )
}

export function GuideSection(): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(0)
  const chapters: GuideChapter[] = GUIDE.chapters

  /** 正文滚了：重新算"停在哪一章" */
  const syncActive = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const maxScroll = body.scrollHeight - body.clientHeight
    setActive(chapterAt(chapterOffsets(body), body.scrollTop, maxScroll))
  }, [])

  // 首次挂载先同步一次：用户可能带着滚动位置回来（切页面再切回去）
  useEffect(() => {
    syncActive()
  }, [syncActive])

  /**
   * 点目录：把正文滚到那一章，并且先把选中项挪过去。
   *
   * 用**瞬时**滚动（`behavior: 'auto'`）而不是平滑动画：目录跳转本来就是这个语义
   * （点一下到那一章），而平滑动画会让"现在停在哪一章"在几百毫秒里飘来飘去，
   * 滚动联动的选中项也跟着闪。瞬时滚动只有一次落点，看得准。
   */
  const goToChapter = (index: number): void => {
    const body = bodyRef.current
    if (!body) return
    setActive(index)
    const maxScroll = body.scrollHeight - body.clientHeight
    body.scrollTo({ top: scrollTopForChapter(chapterOffsets(body), index, maxScroll), behavior: 'auto' })
  }

  return (
    <section className="panel" data-testid="settings-guide">
      <h2 className="panel__title">操作指南</h2>
      <p className="panel__hint">
        七章：这个程序是什么 → 认识界面 → 每个模块怎么用 → 快捷键 → 右键菜单 → 数据、备份与恢复 → 注意事项。
        左边点一下跳到那一章，右边正文自己滚，不会把这一页撑长。
      </p>

      <div className="guide">
        {/* 左侧：章节目录（滚动联动，当前章带 aria-current） */}
        <nav className="guide__toc" data-testid="guide-toc" aria-label="操作指南章节目录">
          {chapters.map((chapter, index) => (
            <button
              key={chapter.index}
              type="button"
              className={`guide__toc-item${index === active ? ' guide__toc-item--active' : ''}`}
              data-testid="guide-toc-item"
              data-chapter-index={index}
              aria-current={index === active ? 'true' : undefined}
              onClick={() => goToChapter(index)}
            >
              {chapterTitle(chapter)}
            </button>
          ))}
        </nav>

        {/* 右侧：正文（自己滚，固定高度） */}
        <div
          className="guide__body"
          data-testid="guide-body"
          tabIndex={0}
          aria-label="操作指南正文"
          ref={bodyRef}
          onScroll={syncActive}
        >
          {chapters.map((chapter, index) => (
            <article
              key={chapter.index}
              className="guide__chapter"
              data-testid="guide-chapter"
              data-guide-chapter={index}
              data-chapter-index={index}
            >
              <h3 className="guide__chapter-title">{chapterTitle(chapter)}</h3>
              {chapter.blocks.map((block, blockIndex) => (
                <GuideBlockView key={blockIndex} block={block} />
              ))}
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
