/**
 * 富文本"显示层"的单测（第 04 块 / FEAT-002）
 *
 * 盯住 `docs\TASKS\04` §6.2 里属于显示层的两条：
 *   - **净化仍生效**：`<script>` / `onerror=` / `javascript:` 依然拦得住
 *     （净化规则本轮一个字都没动，这里从"显示这条路"再验一遍，
 *      防止有人为了显示方便绕开 sanitizeHtml）
 *   - **链接不可点**：渲染出来的 HTML 里**没有 href**，
 *     所以点不到、也 Tab 不到——不是靠"点了没反应"
 *
 * 这里只测纯函数（node 环境，不引入 jsdom）；组件行为由端到端验收覆盖。
 */
import { describe, expect, it } from 'vitest'
import { richDisplay, disableLinks, RICH_LINK_CLASS } from '../../src/shared/richTextDisplay'

describe('richDisplay · 纯文本与富文本分流', () => {
  it('没有 contentFormat 的旧记录：原样当纯文本（零改写）', () => {
    const display = richDisplay('第一行\n第二行')
    expect(display.kind).toBe('text')
    expect(display.content).toBe('第一行\n第二行')
    expect(display.hasLinks).toBe(false)
  })

  it('显式 plain：即使正文里长得像 HTML 也不解析', () => {
    const display = richDisplay('<b>不该变粗</b>', 'plain')
    expect(display.kind).toBe('text')
    expect(display.content).toBe('<b>不该变粗</b>')
  })

  it('rich：交给净化后再渲染', () => {
    const display = richDisplay('<p>一段<strong>粗体</strong></p>', 'rich')
    expect(display.kind).toBe('html')
    expect(display.content).toContain('<strong>粗体</strong>')
  })

  it('rich 但净化后没有内容：按空处理（不留下空块）', () => {
    const display = richDisplay('<p></p><p>  </p>', 'rich')
    expect(display.content).toBe('')
    expect(display.kind).toBe('text')
  })

  it('非字符串输入不抛错', () => {
    expect(richDisplay(undefined).content).toBe('')
    expect(richDisplay(null, 'rich').content).toBe('')
    expect(richDisplay(42).content).toBe('42')
  })
})

describe('richDisplay · 净化仍然生效（规则未被放宽）', () => {
  it('script 连内容一起丢掉', () => {
    const display = richDisplay('<p>前</p><script>alert(1)</script><p>后</p>', 'rich')
    expect(display.content).not.toContain('script')
    expect(display.content).not.toContain('alert')
    expect(display.content).toContain('前')
    expect(display.content).toContain('后')
  })

  it('事件属性（onerror / onclick）被去掉', () => {
    const display = richDisplay('<p onclick="steal()">正文</p><b onerror="x()">粗</b>', 'rich')
    expect(display.content).not.toContain('onclick')
    expect(display.content).not.toContain('onerror')
    expect(display.content).toContain('正文')
    expect(display.content).toContain('粗')
  })

  it('javascript: 与 data: 协议被拦下', () => {
    const display = richDisplay('<a href="javascript:alert(1)">点我</a><a href="data:text/html,x">数据</a>', 'rich')
    expect(display.content).not.toContain('javascript:')
    expect(display.content).not.toContain('data:text/html')
    expect(display.content).toContain('点我')
  })

  it('style / iframe / svg 被丢掉', () => {
    const display = richDisplay('<style>body{display:none}</style><iframe src="http://x"></iframe><p>留我</p>', 'rich')
    expect(display.content).not.toContain('style')
    expect(display.content).not.toContain('iframe')
    expect(display.content).toContain('留我')
  })
})

describe('richDisplay · 链接只能存、不能点开', () => {
  it('渲染结果里没有任何 href 属性', () => {
    const display = richDisplay('<p>看 <a href="https://example.com/x">这个链接</a></p>', 'rich')
    expect(display.hasLinks).toBe(true)
    // 关键断言：DOM 里没有可跳转属性，鼠标点、Tab+回车、右键"打开链接"都不成立
    expect(display.content).not.toMatch(/\shref\s*=/i)
    expect(display.content).toContain('这个链接')
  })

  it('原地址改挂到 data-href，只作展示', () => {
    const display = richDisplay('<a href="https://example.com/x">链接</a>', 'rich')
    expect(display.content).toContain('data-href="https://example.com/x"')
  })

  it('链接带上了"不可点"的 class 与提示文案', () => {
    const display = richDisplay('<a href="https://example.com">链接</a>', 'rich')
    expect(display.content).toContain(RICH_LINK_CLASS)
    expect(display.content).toContain('title="链接只保存')
  })

  it('没有链接时不提"链接"这件事（hasLinks=false）', () => {
    expect(richDisplay('<p>没有链接</p>', 'rich').hasLinks).toBe(false)
    expect(richDisplay('纯文本 https://example.com', undefined).hasLinks).toBe(false)
  })

  it('多个链接都处理到，一个都不漏', () => {
    const { html, hasLinks } = disableLinks(
      '<a href="https://a.example">甲</a> 与 <a href="https://b.example">乙</a>'
    )
    expect(hasLinks).toBe(true)
    expect(html).not.toMatch(/\shref\s*=/i)
    expect((html.match(/data-href=/g) ?? []).length).toBe(2)
  })
})
