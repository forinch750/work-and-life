/**
 * 快速记一笔（PRD §3 第 6 条 / DEVPLAN 阶段 2）
 *
 * 任何页面 Ctrl+Alt+M 唤出，浮在中间的小条，敲完回车即存。
 * 去处可以切换：备忘 / 任务 / 复习卡（阶段 4-5 会逐步接上后两者）。
 */
import { useEffect, useRef, useState } from 'react'
import { getDataApi } from '../lib/dataClient'

export type CaptureTarget = 'memo' | 'plan' | 'review'

const TARGET_LABELS: Record<CaptureTarget, string> = {
  memo: '记为备忘',
  plan: '记为任务',
  review: '记为复习卡'
}

export interface QuickCaptureProps {
  open: boolean
  onClose: () => void
  onSaved: (message: string) => void
}

export function QuickCapture({ open, onClose, onSaved }: QuickCaptureProps): React.JSX.Element | null {
  const [text, setText] = useState('')
  const [target, setTarget] = useState<CaptureTarget>('memo')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const api = getDataApi()
      if (target === 'memo') {
        await api.add('memo', { text: value, pinned: false })
        onSaved('已记为备忘')
      } else if (target === 'plan') {
        const today = new Date()
        const key = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`
        await api.add('plan', { title: value, date: key, timeSlot: 'none', done: false, carriedOver: 0 })
        onSaved('已记为今天的任务')
      } else {
        await api.add('review', { front: value, back: '', stage: 0, dueDate: null, reviewCount: 0 })
        onSaved('已记为复习卡')
      }
      setText('')
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="quick-layer" data-testid="quick-capture">
      <div className="quick-layer__mask" onClick={onClose} aria-hidden="true" />
      <div className="quick" role="dialog" aria-label="快速记一笔">
        <textarea
          ref={inputRef}
          className="quick__field"
          placeholder="记一笔…（回车保存，Shift+回车换行）"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          data-testid="quick-input"
        />
        <div className="quick__footer">
          <select
            className="quick__target"
            value={target}
            onChange={(event) => setTarget(event.target.value as CaptureTarget)}
            data-testid="quick-target"
          >
            {(Object.keys(TARGET_LABELS) as CaptureTarget[]).map((key) => (
              <option key={key} value={key}>
                {TARGET_LABELS[key]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void submit()}
            data-testid="quick-save"
          >
            保存
          </button>
        </div>
        {error ? <p className="quick__error">保存失败：{error}</p> : null}
      </div>
    </div>
  )
}
