/**
 * 保存状态机的单测（第二轮 BUG-006）
 *
 * 为什么测这个：以前编辑完只有一句临时文案，用户分不清
 * "提交了 / 落盘了 / 失败了"。状态机是这套反馈的唯一依据，
 * 它错了界面就会骗人——所以流转与文案都要钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  INITIAL_SAVE_STATUS,
  SAVED_HINT_MS,
  beginSave,
  failSave,
  idleSave,
  isBusy,
  saveStateText,
  shouldAutoReset,
  succeedSave
} from '../../src/shared/saveState'

describe('保存状态机的流转', () => {
  it('初始是 idle，且没有任何错误', () => {
    expect(INITIAL_SAVE_STATUS.state).toBe('idle')
    expect(INITIAL_SAVE_STATUS.error).toBeNull()
  })

  it('一次完整的成功保存：idle → saving → saved → idle', () => {
    let status = idleSave()
    expect(status.state).toBe('idle')

    status = beginSave()
    expect(status.state).toBe('saving')
    expect(isBusy(status)).toBe(true)

    status = succeedSave()
    expect(status.state).toBe('saved')
    expect(status.error).toBeNull()
    // 成功后应当自动回到 idle，否则"已保存"会一直挂着
    expect(shouldAutoReset(status)).toBe(true)

    status = idleSave()
    expect(status.state).toBe('idle')
    expect(isBusy(status)).toBe(false)
  })

  it('失败：进入 error 并保留原因', () => {
    const status = failSave(new Error('磁盘只读'))
    expect(status.state).toBe('error')
    expect(status.error).toBe('磁盘只读')
    // 失败不自动消失，必须让用户看到
    expect(shouldAutoReset(status)).toBe(false)
  })

  it('失败原因支持字符串与非 Error 抛出物', () => {
    expect(failSave('网络断了').error).toBe('网络断了')
    expect(failSave(404).error).toBe('404')
    expect(failSave({ code: 5 }).error).toContain('code')
  })

  it('空原因也要有兜底文案，不能显示成空白', () => {
    expect(failSave('').error).toBe('未知原因')
  })

  it('重新开始保存会清掉上一次的错误', () => {
    const failed = failSave(new Error('上一次失败'))
    expect(failed.error).not.toBeNull()
    expect(beginSave().error).toBeNull()
  })

  it('每次返回新对象，避免调用方误改共享状态', () => {
    const a = idleSave()
    const b = idleSave()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})

describe('保存状态的文案', () => {
  it('idle 不显示任何文字', () => {
    expect(saveStateText(idleSave())).toBe('')
  })

  it('保存中与已保存有明确文案', () => {
    expect(saveStateText(beginSave())).toBe('保存中…')
    expect(saveStateText(succeedSave())).toBe('已保存')
  })

  it('失败文案必须带上原因', () => {
    expect(saveStateText(failSave(new Error('磁盘满了')))).toBe('保存失败：磁盘满了')
  })

  it('提示时长是个正数，不能是 0（否则用户看不到）', () => {
    expect(SAVED_HINT_MS).toBeGreaterThan(0)
  })
})
