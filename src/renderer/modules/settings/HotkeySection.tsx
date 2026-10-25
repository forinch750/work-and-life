/**
 * 快捷键设置（第二轮 FEAT-008 / `MASTER.md` §6.6）
 *
 * 这一节回答四个问题，缺一个用户就不敢用：
 *   1. **有哪些快捷键** —— 全部动作一项不漏，外加一组不可改的固定键
 *   2. **现在绑的是什么** —— 直接显示 `Ctrl+S` 这种人话，不显示 `ctrl+s`
 *   3. **能不能改** —— 点「修改」后按下新组合键即可；冲突当场拒绝并说明被谁占了
 *   4. **改坏了怎么办** —— 单项重置 + 全部重置
 *
 * 两处刻意的设计：
 *   - 抓键用**捕获阶段**监听并 `stopImmediatePropagation`：否则用户想绑 `Ctrl+K` 时，
 *     搜索抽屉会当场弹出来（旧绑定生效），看起来像"改键把页面点炸了"。
 *   - 「单键在输入框里不生效」是产品规定（`操作指南-正文.md` 第四章），因此
 *     单键绑定在这张表上是**允许**的，只是实际触发时输入框内会失效——
 *     这一点写在提示里，避免用户以为快捷键坏了。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  HOTKEY_ACTIONS,
  HOTKEY_LABELS,
  assignHotkey,
  hotkeyConflictGroups,
  isDefaultHotkey,
  resetAllHotkeys,
  resetHotkeyAction,
  normalizeCombo,
  type HotkeyAction
} from '../../../shared/preferences'
import { FIXED_HOTKEYS, comboLabel, hotkeyHint } from '../../../shared/hotkeys'
import { comboFromEvent } from '../../lib/hotkeys'

export interface HotkeySectionProps {
  /** 当前完整绑定表（默认值打底 + 用户改过的覆盖） */
  bindings: Record<HotkeyAction, string>
  /** 保存新的绑定表（父级负责落库并通知全局重读） */
  onChange: (next: Record<HotkeyAction, string>, message: string) => void
}

export function HotkeySection({ bindings, onChange }: HotkeySectionProps): React.JSX.Element {
  /** 正在等待用户按键的动作；null = 没在抓键 */
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const conflicts = useMemo(() => hotkeyConflictGroups(bindings), [bindings])

  /**
   * 抓键：捕获阶段拦住，别让旧绑定在同一按键上先跑一遍。
   *
   * `Escape` 用来取消（不是绑定值）——用户按错了要有退路，
   * 而且 Esc 本来就不能当业务快捷键（抽屉与对话框都靠它关）。
   */
  useEffect(() => {
    if (capturing === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape' || event.key === 'Esc') {
        setCapturing(null)
        setError(null)
        return
      }
      const combo = comboFromEvent(event)
      const result = assignHotkey(bindings, capturing, combo)
      if (result.error !== null) {
        // 失败时**保持抓键状态**：用户可以直接再按一次，不用重新点「修改」
        setError(result.error)
        return
      }
      setCapturing(null)
      setError(null)
      onChange(result.bindings, `已改为 ${comboLabel(result.combo ?? '')}`)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [bindings, capturing, onChange])

  const onReset = useCallback(
    (action: HotkeyAction) => {
      setError(null)
      setCapturing(null)
      const next = resetHotkeyAction(bindings, action)
      onChange(next, `已把「${HOTKEY_LABELS[action]}」恢复为 ${comboLabel(next[action])}`)
    },
    [bindings, onChange]
  )

  const onResetAll = useCallback(() => {
    setError(null)
    setCapturing(null)
    onChange(resetAllHotkeys(), '已把全部快捷键恢复为默认绑定')
  }, [onChange])

  return (
    <section className="panel" data-testid="settings-hotkeys">
      <h2 className="panel__title">快捷键</h2>
      <p className="panel__hint">
        点「修改」后直接按下想要的组合键（Esc 取消）。绑成同一个键会被当场拒绝，
        免得两个动作抢同一个键；改完立即生效，绑定跟着数据一起走。
      </p>
      <p className="panel__hint" data-testid="settings-hotkeys-rule">
        单键（如 N / T）在输入框里**不生效**，避免打字时误触发；带 Ctrl / Alt 的组合键任何情况下都能用。
      </p>

      {conflicts.length > 0 ? (
        <p className="notice notice--error" data-testid="hotkey-conflicts">
          有快捷键被重复占用：
          {conflicts
            .map((group) => `${comboLabel(group.combo)} = ${group.actions.map((a) => HOTKEY_LABELS[a]).join(' / ')}`)
            .join('；')}
        </p>
      ) : null}

      {error !== null ? (
        <p className="notice notice--error" data-testid="hotkey-error">
          {error}
        </p>
      ) : null}

      {capturing !== null ? (
        <p className="notice notice--warn" data-testid="hotkey-capture" data-action={capturing}>
          正在为「{HOTKEY_LABELS[capturing]}」抓键：请按下新的组合键（Esc 取消）
        </p>
      ) : null}

      <ul className="hotkey-list" data-testid="hotkey-list">
        {HOTKEY_ACTIONS.map((action) => {
          const combo = bindings[action]
          const hint = hotkeyHint(action)
          const isCapturing = capturing === action
          const singleKey = normalizeCombo(combo) !== null && !combo.includes('+')
          return (
            <li
              className={`hotkey-row${isCapturing ? ' hotkey-row--capturing' : ''}`}
              key={action}
              data-testid="hotkey-row"
              data-action={action}
              data-combo={combo}
              data-default={isDefaultHotkey(bindings, action) ? '1' : '0'}
            >
              <span className="hotkey-row__label">
                {HOTKEY_LABELS[action]}
                {singleKey ? <span className="hotkey-row__badge" data-testid="hotkey-single">单键</span> : null}
              </span>
              <kbd className="hotkey-row__combo" data-testid="hotkey-combo">
                {comboLabel(combo)}
              </kbd>
              <span className="toolbar__spacer" />
              <button
                type="button"
                className="button"
                data-testid="hotkey-edit"
                onClick={() => {
                  setError(null)
                  setCapturing(isCapturing ? null : action)
                }}
              >
                {isCapturing ? '取消' : '修改'}
              </button>
              <button
                type="button"
                className="button"
                data-testid="hotkey-reset"
                disabled={isDefaultHotkey(bindings, action)}
                onClick={() => onReset(action)}
              >
                重置
              </button>
              {hint !== null ? (
                <span className="hotkey-row__hint" data-testid="hotkey-hint">
                  {hint}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="panel__actions">
        <button
          type="button"
          className="button"
          data-testid="hotkey-reset-all"
          onClick={onResetAll}
        >
          全部恢复默认
        </button>
      </div>

      {/*
        固定快捷键：不可改。这几条是"操作姿势"（空格 = 显示答案、1/2/3 = 三档评分），
        与复习手感绑死，改了反而会把用户指南写死的那套操作拆散，所以只列出来。
      */}
      <h3 className="panel__subtitle">固定快捷键（不可改）</h3>
      <ul className="hotkey-list hotkey-list--fixed" data-testid="hotkey-fixed-list">
        {FIXED_HOTKEYS.map((item) => (
          <li className="hotkey-row" key={`${item.combo}-${item.label}`} data-testid="hotkey-fixed-row">
            <kbd className="hotkey-row__combo">{comboLabel(item.combo)}</kbd>
            <span className="hotkey-row__label">{item.label}</span>
            <span className="toolbar__spacer" />
            <span className="hotkey-row__hint">{item.scope}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
