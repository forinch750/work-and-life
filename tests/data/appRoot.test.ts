/**
 * 阶段 0 测试：应用根目录解析（阶段 7 修订后的规则）
 *
 * 规则：
 *   1. WORKLIFE_ROOT 覆盖一切（便携模式）
 *   2. 开发态用当前工作目录
 *   3. 打包态用传入的用户数据目录（%APPDATA%\工作生活）
 *
 * 这条规则决定"数据到底存在哪"，是 PRD K3 的前提，必须精确可测。
 */
import { describe, expect, it } from 'vitest'
import { resolveAppRoot } from '../../src/main/appRoot'

describe('resolveAppRoot', () => {
  const packaged = {
    isPackaged: true,
    cwd: 'C:\\Windows\\System32',
    packagedRoot: 'C:\\Users\\HP\\AppData\\Roaming\\工作生活'
  }

  it('开发态使用当前工作目录', () => {
    expect(
      resolveAppRoot({
        isPackaged: false,
        cwd: 'D:\\工作生活',
        packagedRoot: 'C:\\Users\\HP\\AppData\\Roaming\\工作生活'
      })
    ).toBe('D:\\工作生活')
  })

  it('打包态使用用户数据目录', () => {
    expect(resolveAppRoot(packaged)).toBe('C:\\Users\\HP\\AppData\\Roaming\\工作生活')
  })

  it('环境变量覆盖优先级最高（便携模式）', () => {
    expect(resolveAppRoot({ ...packaged, envOverride: 'E:\\我的数据' })).toBe('E:\\我的数据')
    expect(
      resolveAppRoot({
        isPackaged: false,
        cwd: 'D:\\工作生活',
        packagedRoot: undefined,
        envOverride: 'E:\\便携数据'
      })
    ).toBe('E:\\便携数据')
  })

  it('空字符串或纯空白的覆盖值会被忽略', () => {
    expect(resolveAppRoot({ ...packaged, envOverride: '' })).toBe(
      'C:\\Users\\HP\\AppData\\Roaming\\工作生活'
    )
    expect(resolveAppRoot({ ...packaged, envOverride: '   ' })).toBe(
      'C:\\Users\\HP\\AppData\\Roaming\\工作生活'
    )
  })

  it('打包态拿不到用户数据目录时退回工作目录（不写到奇怪的地方）', () => {
    expect(
      resolveAppRoot({ isPackaged: true, cwd: 'D:\\工作生活', packagedRoot: undefined })
    ).toBe('D:\\工作生活')
    expect(resolveAppRoot({ isPackaged: true, cwd: 'D:\\工作生活', packagedRoot: '' })).toBe(
      'D:\\工作生活'
    )
  })

  it('返回值一定是绝对路径', () => {
    const result = resolveAppRoot({ isPackaged: false, cwd: '.', packagedRoot: undefined })
    expect(result).toBe(process.cwd())
  })
})
