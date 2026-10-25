/**
 * 富文本的**显示**组件（第二轮 FEAT-002 / `TASKS\04`）
 *
 * 与 `RichText.tsx`（编辑器）配套：一个负责写，一个负责读。
 *
 * 三条规矩（都来自 `TASKS\04` §五）：
 *   1. 按 `contentFormat` 决定渲染方式：缺省即 `plain`，旧数据因此**零改写**、
 *      显示行为与升级前完全一致
 *   2. 富文本一律先净化（`richDisplay` 内部走 `sanitizeHtml`），
 *      `dangerouslySetInnerHTML` 只吃净化后的字符串，**绝不吃原文**
 *   3. 链接**只能存、不能点开**：渲染出来的 `<a>` 连 `href` 都没有，
 *      另外再挂一层点击拦截（双保险），并给一句提示
 */
import type { ContentFormat } from '../../shared/richText'
import { isRichContent } from '../../shared/richText'
import { richDisplay } from '../../shared/richTextDisplay'

export interface RichTextViewProps {
  /** 正文：富文本是 HTML，纯文本是原文 */
  value: string
  /** 格式标记；缺省按纯文本（旧记录即如此） */
  format?: ContentFormat
  testId?: string
  className?: string
  /** 链接提示的文案（正文里有链接时才显示） */
  linkHint?: string
}

/**
 * 显示一段正文。
 *
 * 空内容返回 null：调用点就不用每处都写一次 `value ? ... : null`，
 * 也不会在页面上留下一个空的占位块。
 */
export function RichTextView({
  value,
  format,
  testId,
  className,
  linkHint = '链接只保存，点不开（程序不联网）'
}: RichTextViewProps): React.JSX.Element | null {
  const display = richDisplay(value, format)
  if (display.content === '') return null

  const rich = isRichContent(format)
  const classes = `rich-text__view${rich ? ' rich-text__view--html' : ''}${className ? ` ${className}` : ''}`

  return (
    <div
      className={classes}
      data-testid={testId}
      data-content-format={rich ? 'rich' : 'plain'}
      data-has-links={display.hasLinks ? 'true' : 'false'}
      onClick={(event) => {
        // 双保险：DOM 里已经没有 href 了，这里再把点击拦死。
        // 用 closest 而不是 e.target.tagName，是为了覆盖 <a> 里还有 <b>/<code> 的情况。
        const target = event.target as HTMLElement | null
        if (target !== null && typeof target.closest === 'function' && target.closest('a') !== null) {
          event.preventDefault()
        }
      }}
    >
      {display.kind === 'text' ? (
        // 纯文本用 React 文本子节点渲染：连转义都不用操心
        <div className="rich-text__plain">{display.content}</div>
      ) : (
        // 只有净化过的 display.content 才允许进这里（见文件头第 2 条）
        <div className="rich-text__html" dangerouslySetInnerHTML={{ __html: display.content }} />
      )}
      {display.hasLinks ? (
        <p
          className="rich-text__link-hint"
          data-testid={testId === undefined ? undefined : `${testId}-link-hint`}
        >
          {linkHint}
        </p>
      ) : null}
    </div>
  )
}
