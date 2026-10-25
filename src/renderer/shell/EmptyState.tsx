/**
 * 空状态（PRD：每个模块第一次打开不是空白，而是一句引导语；不做花哨插图）
 */

export interface EmptyStateProps {
  /** 一句引导语 */
  message: string
  /** 可选的补充说明 */
  hint?: string
  testId?: string
}

export function EmptyState({ message, hint, testId }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state" data-testid={testId ?? 'empty-state'}>
      <p className="empty-state__message">{message}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
    </div>
  )
}
