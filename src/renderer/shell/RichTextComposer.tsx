/**
 * 富文本"一行写完就存"的输入区（第二轮 FEAT-002 / `TASKS\04`）
 *
 * 备忘 / 学习日志 / 摘录这三处的交互与原来的 `InlineInput` 一致：
 * 输入正文 → 按约定的键保存 → 成功则清空，失败则**原样保留**输入。
 * 区别只有一个：正文换成 contentEditable 富文本（`RichText.tsx`）。
 *
 * 为什么不直接把 `InlineInput` 换成 `RichText`、自己再拼一遍保存逻辑：
 * 保存三态（保存中 / 已保存 / 保存失败）、Ctrl+回车、失败保留输入这几条
 * 在每处都会漂，漂一次就是"内容白写了"。所以收在一个组件里。
 */
import { useCallback, useState } from 'react'
import type { ContentFormat } from '../../shared/richText'
import { saveStateText } from '../../shared/saveState'
import { useSaveState, type SaveStateController } from '../lib/saveState'
import { RichText } from './RichText'

/**
 * 保存三态的提示条。
 *
 * 供"自己在抽屉里拼编辑区"的场合复用（学习日志抽屉、标记读完抽屉）——
 * 那两处保存按钮在抽屉 footer 上，不由 `RichTextComposer` 托管，
 * 但**提示的样子必须一样**，否则同一个应用里会出现两套"保存中/已保存"的写法。
 */
export function SaveHint({
  save,
  testId
}: {
  save: SaveStateController
  testId?: string
}): React.JSX.Element | null {
  if (save.state === 'idle') return null
  return (
    <span
      className={save.state === 'error' ? 'inline-input__error' : 'inline-input__hint'}
      data-testid={testId ?? 'save-state'}
      data-save-state={save.state}
    >
      {saveStateText(save)}
    </span>
  )
}

export type ComposerSubmitKey = 'enter' | 'ctrl-enter'

export interface RichTextComposerProps {
  /** 编辑器本体的 testId（工具条按钮会是 `${testId}-bold` 这种） */
  testId: string
  placeholder: string
  /**
   * 保存动作。抛错即"保存失败"：输入内容会**保留**，不会丢用户写的东西。
   * `format` 恒为 `'rich'`（这个组件产出的就是富文本）。
   */
  onSubmit: (text: string, format: ContentFormat) => Promise<void>
  /** 用哪个键提交：`ctrl-enter`（多行正文，默认）/ `enter`（单行式） */
  submitKey?: ComposerSubmitKey
  /** 保存成功后是否清空编辑器（新建场景 true；就地编辑场景 false） */
  resetAfterSubmit?: boolean
  submitLabel?: string
  minHeight?: number
}

export function RichTextComposer({
  testId,
  placeholder,
  onSubmit,
  submitKey = 'ctrl-enter',
  resetAfterSubmit = true,
  submitLabel = '保存',
  minHeight = 120
}: RichTextComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState<{ text: string; format: ContentFormat }>({
    text: '',
    format: 'rich'
  })
  const [flash, setFlash] = useState(false)
  // 保存三态（BUG-006）：保存中 / 已保存 / 保存失败
  const save = useSaveState()

  const submit = useCallback(async (): Promise<void> => {
    // 空内容不提交：`htmlToPlainText` 为空时 normalizeRichText 已经返回空文本
    if (draft.text.trim() === '') return
    await save.run(() => onSubmit(draft.text, draft.format))
    // 判断成败用 save.failed（读 ref），不能用返回值——
    // `Promise<void>` 成功时返回值也是 undefined（详见 lib/saveState.ts 文件头）
    if (save.failed) return // 失败：输入原样留着，别让用户白写
    if (resetAfterSubmit) setDraft({ text: '', format: 'rich' })
    setFlash(true)
    setTimeout(() => setFlash(false), 1200)
  }, [draft.format, draft.text, onSubmit, resetAfterSubmit, save])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    const withModifier = event.ctrlKey || event.metaKey
    // `enter` 模式：回车就存，Shift+回车留给换行；
    // `ctrl-enter` 模式：只认 Ctrl/Cmd+回车，回车正常换行（多行正文要能换行）
    const trigger = submitKey === 'ctrl-enter' ? withModifier : withModifier || !event.shiftKey
    if (!trigger) return
    event.preventDefault()
    void submit()
  }

  /**
   * 状态提示优先级：保存失败 > 保存中 / 已保存 > 成功提示。
   * 失败时必须说出来（并且带着原因），排最高。
   */
  const statusText = save.state === 'idle' ? (flash ? '已保存' : '') : saveStateText(save)

  return (
    <div className="rich-composer" data-testid={testId ? `${testId}-composer` : undefined} onKeyDown={onKeyDown}>
      <RichText
        value={draft.text}
        format={draft.format}
        placeholder={placeholder}
        testId={testId}
        minHeight={minHeight}
        onChange={(text, format) => setDraft({ text, format })}
      />
      <div className="rich-composer__footer">
        <span className="inline-input__tip">
          {submitKey === 'ctrl-enter' ? 'Ctrl+回车 保存' : '回车 保存（Shift+回车 换行）'}
        </span>
        {statusText === '' ? null : (
          <span
            className={save.state === 'error' ? 'inline-input__error' : 'inline-input__hint'}
            data-testid="save-state"
            data-save-state={save.state}
          >
            {statusText}
          </span>
        )}
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="button button--primary"
          data-testid={`${testId}-save`}
          disabled={save.state === 'saving'}
          onClick={() => void submit()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
