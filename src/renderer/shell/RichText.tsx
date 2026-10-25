/**
 * 富文本编辑器（第二轮 FEAT-002 的地基）
 *
 * 本轮只提供组件，**不接入任何页面**（接入在 2.2 轮）。
 *
 * 为什么自己写而不用第三方库：本项目零运行时依赖是刻意的立场
 * （见 PERMISSIONS.md：依赖包不在本机执行安装脚本）。
 *
 * 安全与格式处理的纯逻辑在 src\shared\richText.ts：
 *   - 粘贴进来的内容一律先过 sanitizeHtml（去掉 script / on* / javascript:）
 *   - 落库时用 normalizeRichText 收敛成 { text, contentFormat }
 *
 * 链接只存不点开：程序拦截一切外部请求且禁用 shell.openExternal，
 * 所以渲染出来的 <a> 不能有真实跳转行为（见 PERMISSIONS.md）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  normalizeEditorHtml,
  normalizeRichText,
  sanitizeHtml,
  type ContentFormat
} from '../../shared/richText'

/** 工具条上的按钮 */
interface ToolSpec {
  id: string
  label: string
  /** 显示用的短标签 */
  title: string
  command: string
  /** 需要传入的值（例如标题级别、引用） */
  value?: string
}

const TOOLS: ToolSpec[] = [
  { id: 'bold', label: 'B', title: '加粗', command: 'bold' },
  { id: 'italic', label: 'I', title: '斜体', command: 'italic' },
  { id: 'underline', label: 'U', title: '下划线', command: 'underline' },
  { id: 'h2', label: 'H', title: '标题', command: 'formatBlock', value: 'h2' },
  { id: 'ul', label: '•', title: '无序列表', command: 'insertUnorderedList' },
  { id: 'ol', label: '1.', title: '有序列表', command: 'insertOrderedList' },
  { id: 'quote', label: '❝', title: '引用', command: 'formatBlock', value: 'blockquote' },
  { id: 'code', label: '</>', title: '代码块', command: 'formatBlock', value: 'pre' }
]

export interface RichTextProps {
  /** 初始内容（富文本为 HTML，纯文本为原文） */
  value: string
  /** 内容格式；缺省按纯文本处理（旧数据即如此） */
  format?: ContentFormat
  placeholder?: string
  testId?: string
  /** 内容变化（已净化）。第二个参数是应当落库的格式标记 */
  onChange: (text: string, format: ContentFormat) => void
  /** 是否只读 */
  readOnly?: boolean
  minHeight?: number
}

export function RichText({
  value,
  format,
  placeholder,
  testId,
  onChange,
  readOnly = false,
  minHeight = 140
}: RichTextProps): React.JSX.Element {
  const editorRef = useRef<HTMLDivElement | null>(null)
  /** 上一次由**本编辑器**发出去的规范化文本（用于区分"外部改值"与"自己刚发的"） */
  const lastEmittedRef = useRef<string | null>(null)
  const [linkPromptOpen, setLinkPromptOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')

  /**
   * 把外部值写进 contentEditable。
   *
   * 只在"外部值与编辑器当前内容不同"时写，否则每次输入都会重置光标位置——
   * 那会导致打字时光标乱跳，是最典型的 contentEditable 事故。
   *
   * 第 04 块补的一道判断：**自己刚发出去的值不回写**。
   * 原因是不回写也会误判"不同"：浏览器在 contentEditable 里回车会插 `<div>`，
   * 而净化只认 `<br>`，于是 `abc<div><br></div>` 与 `abc<br />` 被当成两个值，
   * 每次按键都重写一遍 innerHTML、光标被甩到末尾（实际打字时会踩到）。
   * 用 `lastEmittedRef` 记下自己发出去的那份，就只剩"真·外部改值"会回写。
   */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (value === lastEmittedRef.current) return
    // 纯文本进来要转义，否则文字里的 < 会被当成标签
    const next = format === 'rich' ? value : escapeForDisplay(value)
    if (editor.innerHTML !== next) editor.innerHTML = next
    // format 参与判断，但不需要触发重写
  }, [value, format])

  const emitChange = useCallback((): void => {
    const editor = editorRef.current
    if (!editor) return
    // 先做编辑器侧的规范化（contentEditable 的 <div> 换行 → 白名单认识的 <p>），
    // 否则多行内容会在净化那一步被脱壳、换行整段丢掉（见 richText.normalizeEditorHtml）
    const normalized = normalizeRichText(normalizeEditorHtml(editor.innerHTML), 'rich')
    lastEmittedRef.current = normalized.text
    onChange(normalized.text, 'rich')
  }, [onChange])

  /**
   * 粘贴处理：一律拦掉浏览器默认行为，自己插入净化后的内容。
   *
   * 这是本编辑器最关键的一处防护——从网页或 Word 复制进来的东西
   * 可能带 script、onerror、内联样式，直接进 DOM 会污染数据。
   */
  const onPaste = useCallback(
    (event: React.ClipboardEvent): void => {
      if (readOnly) return
      event.preventDefault()
      const html = event.clipboardData.getData('text/html')
      const text = event.clipboardData.getData('text/plain')
      const safe = html !== '' ? sanitizeHtml(html) : escapeForDisplay(text)
      insertHtmlAtCursor(safe)
      emitChange()
    },
    [emitChange, readOnly]
  )

  const runCommand = useCallback(
    (tool: ToolSpec): void => {
      if (readOnly) return
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      // 本程序是本地应用，不存在跨站脚本风险；这里的命令都由固定按钮触发
      document.execCommand(tool.command, false, tool.value)
      emitChange()
    },
    [emitChange, readOnly]
  )

  const confirmLink = useCallback((): void => {
    const url = linkValue.trim()
    setLinkPromptOpen(false)
    setLinkValue('')
    if (url === '') return
    // 与 sanitizeHtml 保持同一套协议白名单：只允许 http/https
    if (!/^https?:\/\//i.test(url)) return
    insertHtmlAtCursor(`<a href="${url.replace(/"/g, '&quot;')}">${escapeForDisplay(url)}</a>`)
    emitChange()
  }, [emitChange, linkValue])

  return (
    <div className="rich-text" data-testid={testId ? `${testId}-root` : undefined}>
      {readOnly ? null : (
        <div className="rich-text__toolbar" data-testid={testId ? `${testId}-toolbar` : undefined}>
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="rich-text__tool"
              title={tool.title}
              data-testid={testId ? `${testId}-${tool.id}` : undefined}
              // 用 mousedown 而不是 click：click 之前编辑器会失焦，选区丢失
              onMouseDown={(event) => {
                event.preventDefault()
                runCommand(tool)
              }}
            >
              {tool.label}
            </button>
          ))}
          <button
            type="button"
            className="rich-text__tool"
            title="链接（只能存，程序不会打开它）"
            data-testid={testId ? `${testId}-link` : undefined}
            onMouseDown={(event) => {
              event.preventDefault()
              setLinkPromptOpen(true)
            }}
          >
            链接
          </button>
        </div>
      )}

      {linkPromptOpen ? (
        <div className="rich-text__link" data-testid={testId ? `${testId}-link-row` : undefined}>
          <input
            className="field__control"
            placeholder="https://…（程序只保存链接，不会打开它）"
            value={linkValue}
            autoFocus
            data-testid={testId ? `${testId}-link-input` : undefined}
            onChange={(event) => setLinkValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmLink()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setLinkPromptOpen(false)
                setLinkValue('')
              }
            }}
          />
          <button type="button" className="button" onClick={confirmLink}>
            插入
          </button>
        </div>
      ) : null}

      <div
        ref={editorRef}
        className="rich-text__editor"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder ?? ''}
        data-testid={testId}
        style={{ minHeight }}
        onInput={emitChange}
        onBlur={emitChange}
        onPaste={onPaste}
      />
    </div>
  )
}

/** 把纯文本转义成可安全放进 innerHTML 的形式（保留换行） */
export function escapeForDisplay(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />')
}

/**
 * 在当前光标处插入 HTML。
 *
 * 用 execCommand('insertHTML')：它由浏览器处理选区、光标与撤销栈，
 * 比手工 Range 拼接可靠得多（手工插入后光标位置、撤销栈都要自己维护）。
 * 内容在调用前必须已经过 sanitizeHtml。
 */
export function insertHtmlAtCursor(html: string): void {
  if (html === '') return
  document.execCommand('insertHTML', false, html)
}
