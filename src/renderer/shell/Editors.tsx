/**
 * 三种统一编辑交互（PRD §2.4 / DEVPLAN 阶段 2）
 *   1. 行内输入：短内容，回车即存，保存后保持焦点可连记
 *   2. 右侧抽屉：详细内容，不离开当前页
 *   3. 居中对话框：危险操作，二次确认
 */
import { useEffect, useRef, useState } from 'react'
import type { ContentFormat } from '../../shared/richText'
import { normalizeRichText } from '../../shared/richText'
import { saveStateText } from '../../shared/saveState'
import { useSaveState } from '../lib/saveState'
import { RichText } from './RichText'

// ---------------------------------------------------------------------------
// 1. 行内输入
// ---------------------------------------------------------------------------

export interface InlineInputProps {
  placeholder: string
  onSubmit: (value: string) => void | Promise<void>
  /** 提交成功后的提示文案，例如"已保存"。保存状态会覆盖显示（见下） */
  hint?: string
  testId?: string
  /** 是否支持多行（Ctrl+Enter 提交） */
  multiline?: boolean
}

export function InlineInput({
  placeholder,
  onSubmit,
  hint,
  testId,
  multiline = false
}: InlineInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [flash, setFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // 保存三态（BUG-006）：保存中 / 已保存 / 保存失败
  const save = useSaveState()

  const submit = async (): Promise<void> => {
    const trimmed = value.trim()
    if (trimmed === '') return
    // 失败时不清理输入框——把用户刚写的东西留着，别让人白写一遍
    await save.run(() => Promise.resolve(onSubmit(trimmed)))
    // 判断成败用 save.failed（读 ref），不能用返回值——
    // `Promise<void>` 成功时返回值也是 undefined（详见 lib/saveState.ts 文件头）
    if (save.failed) return
    setValue('')
    setFlash(true)
    setTimeout(() => setFlash(false), 1200)
    // 保持焦点，方便连着记多条
    inputRef.current?.focus()
  }

  const commonProps = {
    className: 'inline-input__field',
    placeholder,
    value,
    'data-testid': testId,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(event.target.value)
  }

  /**
   * 状态提示优先级：
   *   保存失败 > 保存中/已保存 > 提交成功提示（hint）
   * 失败时一定要说出来，所以排在最高。
   */
  const statusText =
    save.state === 'idle' ? (flash && hint ? hint : '') : saveStateText(save)

  const statusNode =
    statusText === '' ? null : (
      <span
        className={save.state === 'error' ? 'inline-input__error' : 'inline-input__hint'}
        data-testid="save-state"
        data-save-state={save.state}
      >
        {statusText}
      </span>
    )

  if (multiline) {
    return (
      <div className="inline-input">
        <textarea
          {...commonProps}
          ref={(node) => {
            inputRef.current = node
          }}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="inline-input__footer">
          <span className="inline-input__tip">Ctrl+回车 保存</span>
          {statusNode}
          <button type="button" className="button" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="inline-input">
      <input
        {...commonProps}
        ref={(node) => {
          inputRef.current = node
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      />
      {statusNode}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. 右侧抽屉
// ---------------------------------------------------------------------------

export interface DrawerProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  testId?: string
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  testId
}: DrawerProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-layer" data-testid={testId ?? 'drawer'}>
      <div className="drawer-layer__mask" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={title}>
        <header className="drawer__header">
          <h2 className="drawer__title">{title}</h2>
          <button
            type="button"
            className="drawer__close"
            onClick={onClose}
            aria-label="关闭"
            data-testid="drawer-close"
          >
            ✕
          </button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="drawer__footer">{footer}</footer> : null}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. 通用表单抽屉（第二轮 BUG-001/002/004/005 的共用底座）
// ---------------------------------------------------------------------------

/**
 * 字段定义。
 *
 * 为什么抽通用件：任务、学习主题、书、备忘、复习卡都要"能新建、能编辑"，
 * 如果每个模块各写一份表单，字段校验、保存状态、抽屉布局会各漂各的。
 */
/** 所有字段共有的部分 */
interface FormFieldBase {
  key: string
  label: string
  /** 是否必填（空值会拦住保存） */
  required?: boolean
  testId?: string
  hint?: string
}

export type FormField =
  | (FormFieldBase & {
      kind: 'text'
      placeholder?: string
      /** 多行文本用 textarea */
      multiline?: boolean
    })
  | (FormFieldBase & {
      /**
       * 富文本字段（第 04 块）。
       *
       * 值在 `FormValues` 里仍然是字符串，但内容是**净化后的 HTML**，
       * 配套的格式标记走 `FormDrawerProps.onSubmit` 的第二个参数
       * （`formats[field.key]`）。第一块正文类字段（`memo.text`、
       * `Book.review`、`Task.note`）都是这样接进来的。
       */
      kind: 'rich'
      placeholder?: string
      minHeight?: number
    })
  | (FormFieldBase & { kind: 'date' })
  | (FormFieldBase & { kind: 'time' })
  | (FormFieldBase & { kind: 'select'; options: Array<{ value: string; label: string }> })
  | (FormFieldBase & { kind: 'number'; min?: number; max?: number })

export type FormValues = Record<string, string>

/** 富文本字段当前的格式标记（缺省即 plain） */
export type FormFormats = Record<string, ContentFormat>

export interface FormDrawerProps {
  open: boolean
  title: string
  fields: FormField[]
  /** 初始值；每次打开时按它重置表单 */
  initialValues: FormValues
  /** 富文本字段的初始格式标记（旧记录没有这个字段即 plain） */
  initialFormats?: FormFormats
  onClose: () => void
  /**
   * 提交。返回 promise，失败时表单保持打开并显示原因。
   *
   * 第二个参数是富文本字段的格式标记：纯文本字段不会出现在里面。
   * 落库时请用 `normalizeRichText(values[key], formats[key])` 再收一次口
   * （编辑器已经净化过，这里只是防止调用方漏传格式标记）。
   */
  onSubmit: (values: FormValues, formats: FormFormats) => Promise<void>
  testId?: string
  submitLabel?: string
}

export function FormDrawer({
  open,
  title,
  fields,
  initialValues,
  initialFormats,
  onClose,
  onSubmit,
  testId,
  submitLabel = '保存'
}: FormDrawerProps): React.JSX.Element | null {
  const [values, setValues] = useState<FormValues>(initialValues)
  const [formats, setFormats] = useState<FormFormats>(initialFormats ?? {})
  const [error, setError] = useState<string | null>(null)
  const save = useSaveState()
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  // 每次打开：按初始值重置，并聚焦第一个字段
  useEffect(() => {
    if (!open) return
    setValues(initialValues)
    setFormats(initialFormats ?? {})
    setError(null)
    save.reset()
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 0)
    return () => clearTimeout(timer)
    // initialValues / initialFormats 每次渲染都是新对象，不能进依赖数组；用 open 触发重置即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const setValue = (key: string, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const setRichValue = (key: string, text: string, format: ContentFormat): void => {
    setValues((current) => ({ ...current, [key]: text }))
    setFormats((current) => ({ ...current, [key]: format }))
  }

  const submit = async (): Promise<void> => {
    // 必填校验：宁可在这里拦住，也不要把空标题写进数据文件
    const missing = fields.find((field) => {
      const requiresValue =
        (field.kind === 'text' && field.required === true) ||
        (field.kind === 'rich' && field.required === true) ||
        (field.kind === 'date' && field.required === true) ||
        (field.kind === 'time' && field.required === true) ||
        (field.kind === 'number' && field.required === true)
      if (!requiresValue) return false
      // 富文本要按"纯文本是不是空的"判断，否则 `<p></p>` 会被当成有内容
      if (field.kind === 'rich') {
        return normalizeRichText(values[field.key], formats[field.key]).text === ''
      }
      return (values[field.key] ?? '').trim() === ''
    })
    if (missing) {
      setError(`请填写「${missing.label}」`)
      return
    }
    setError(null)
    await save.run(() => onSubmit(values, formats))
    // 判断成败用 save.failed（读 ref），不能用返回值——
    // `Promise<void>` 成功时返回值也是 undefined（详见 lib/saveState.ts 文件头）
    if (save.failed) {
      setError(save.lastError ?? '保存失败')
      return
    }
    onClose()
  }

  const renderField = (field: FormField, index: number): React.JSX.Element => {
    const value = values[field.key] ?? ''
    const controlId = testId ? `${testId}-${field.key}` : undefined
    const testIdValue = field.testId ?? controlId

    return (
      <label key={field.key} className="field" htmlFor={controlId}>
        <span className="field__label">{field.label}</span>
        {field.kind === 'text' && field.multiline ? (
          <textarea
            id={controlId}
            className="field__control"
            rows={3}
            placeholder={field.placeholder}
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        ) : null}
        {field.kind === 'text' && !field.multiline ? (
          <input
            id={controlId}
            ref={index === 0 ? firstFieldRef : undefined}
            className="field__control"
            placeholder={field.placeholder}
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        ) : null}
        {field.kind === 'date' ? (
          <input
            id={controlId}
            type="date"
            className="field__control"
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        ) : null}
        {field.kind === 'time' ? (
          <input
            id={controlId}
            type="time"
            className="field__control"
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        ) : null}
        {field.kind === 'number' ? (
          <input
            id={controlId}
            type="number"
            className="field__control"
            min={field.min}
            max={field.max}
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        ) : null}
        {field.kind === 'select' ? (
          <select
            id={controlId}
            className="field__control"
            value={value}
            data-testid={testIdValue}
            onChange={(event) => setValue(field.key, event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {field.kind === 'rich' ? (
          <RichText
            value={value}
            format={formats[field.key]}
            placeholder={field.placeholder}
            testId={testIdValue}
            minHeight={field.minHeight ?? 120}
            onChange={(text, format) => setRichValue(field.key, text, format)}
          />
        ) : null}
        {field.hint ? <span className="field__hint">{field.hint}</span> : null}
      </label>
    )
  }

  return (
    <Drawer
      open={open}
      title={title}
      onClose={onClose}
      testId={testId}
      footer={
        <div className="form__footer">
          {/* 保存状态必须可见：保存中 / 已保存 / 保存失败（含原因） */}
          {save.state !== 'idle' ? (
            <span
              className={save.state === 'error' ? 'inline-input__error' : 'inline-input__hint'}
              data-testid={testId ? `${testId}-save-state` : 'form-save-state'}
              data-save-state={save.state}
            >
              {saveStateText(save)}
            </span>
          ) : null}
          <span className="toolbar__spacer" />
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={save.state === 'saving'}
            data-testid={testId ? `${testId}-submit` : 'form-submit'}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </div>
      }
    >
      {error ? (
        <p className="notice notice--error" data-testid={testId ? `${testId}-error` : 'form-error'}>
          {error}
        </p>
      ) : null}
      {fields.map((field, index) => renderField(field, index))}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// 3. 居中确认对话框
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** 要求输入的确认文字（例如"清空"），不填则不需要输入 */
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
  testId?: string
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  confirmText,
  onConfirm,
  onCancel,
  testId
}: ConfirmDialogProps): React.JSX.Element | null {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const blocked = confirmText !== undefined && typed.trim() !== confirmText

  return (
    <div className="dialog-layer" data-testid={testId ?? 'confirm-dialog'}>
      <div className="dialog-layer__mask" onClick={onCancel} aria-hidden="true" />
      <div className="dialog" role="alertdialog" aria-label={title}>
        <h2 className="dialog__title">{title}</h2>
        <div className="dialog__message">{message}</div>

        {confirmText !== undefined ? (
          <label className="dialog__confirm-text">
            <span>
              请输入「{confirmText}」以确认：
            </span>
            <input
              className="dialog__input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              data-testid="confirm-dialog-input"
              autoFocus
            />
          </label>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel} data-testid="dialog-cancel">
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'button button--danger' : 'button button--primary'}
            disabled={blocked}
            onClick={onConfirm}
            data-testid="dialog-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
