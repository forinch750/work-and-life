/**
 * 富文本净化与抽文本的单测（第二轮 FEAT-002）
 *
 * 为什么测这么细：
 *   - sanitizeHtml 是唯一挡住"粘贴进来的脏 HTML"的地方，漏一个就真出问题
 *   - toPlainText 决定搜索结果与复习卡内容——漏了标签用户会看到一堆 <p>
 *   - 旧数据是纯文本且没有格式标记，兼容性必须钉死，否则一升级就乱
 */
import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  htmlToPlainText,
  isRichContent,
  normalizeRichText,
  sanitizeHtml,
  toPlainText
} from '../../src/shared/richText'

describe('decodeEntities', () => {
  it('还原常见命名实体', () => {
    expect(decodeEntities('&lt;p&gt;')).toBe('<p>')
    expect(decodeEntities('a&nbsp;b')).toBe('a b')
    expect(decodeEntities('&quot;引号&quot;')).toBe('"引号"')
    expect(decodeEntities('&#39;单引号&#39;')).toBe("'单引号'")
  })

  it('还原十进制与十六进制实体', () => {
    expect(decodeEntities('&#65;&#66;')).toBe('AB')
    expect(decodeEntities('&#x4e2d;&#x6587;')).toBe('中文')
  })

  it('&amp; 最后解码，不做二次解码', () => {
    // 关键：&amp;lt; 应当只还原成 &lt; 这个"字面文本"，不能再变成 <
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('a &amp; b')).toBe('a & b')
  })

  it('没有实体时原样返回', () => {
    expect(decodeEntities('普通文本')).toBe('普通文本')
  })
})

describe('sanitizeHtml 净化', () => {
  it('保留白名单标签', () => {
    expect(sanitizeHtml('<p>段落</p>')).toBe('<p>段落</p>')
    expect(sanitizeHtml('<strong>粗</strong>')).toBe('<strong>粗</strong>')
    expect(sanitizeHtml('<ul><li>项</li></ul>')).toBe('<ul><li>项</li></ul>')
  })

  it('连内容一起丢掉 script', () => {
    const out = sanitizeHtml('<p>前</p><script>alert(1)</script><p>后</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('前')
    expect(out).toContain('后')
  })

  it('丢掉 style / iframe / svg（含内容）', () => {
    expect(sanitizeHtml('<style>body{display:none}</style>文字')).toBe('文字')
    expect(sanitizeHtml('<iframe src="http://x"></iframe>文字')).toBe('文字')
    expect(sanitizeHtml('<svg><circle/></svg>文字')).toBe('文字')
  })

  it('未闭合的 script 也丢干净（不能残留半截）', () => {
    const out = sanitizeHtml('<p>可见</p><script>alert(1)')
    expect(out).not.toContain('alert')
    expect(out).toContain('可见')
  })

  it('去掉 on* 事件属性', () => {
    expect(sanitizeHtml('<p onclick="alert(1)">文字</p>')).toBe('<p>文字</p>')
    expect(sanitizeHtml("<p onmouseover='x()'>文字</p>")).toBe('<p>文字</p>')
    expect(sanitizeHtml('<img src=x onerror=alert(1)>')).not.toContain('onerror')
  })

  it('去掉 style 属性', () => {
    expect(sanitizeHtml('<p style="color:red">文字</p>')).toBe('<p>文字</p>')
  })

  it('拦掉 javascript: 链接', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">点</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('点')
  })

  it('拦掉 data: 与 vbscript: 链接', () => {
    expect(sanitizeHtml('<a href="data:text/html;base64,xx">x</a>')).not.toContain('data:')
    expect(sanitizeHtml('<a href="vbscript:x">x</a>')).not.toContain('vbscript:')
  })

  it('正常链接保留 href（但程序不会去打开它）', () => {
    expect(sanitizeHtml('<a href="https://example.com">站</a>')).toBe(
      '<a href="https://example.com">站</a>'
    )
  })

  it('非白名单标签只脱壳，文字保留', () => {
    expect(sanitizeHtml('<div><span>文字</span></div>')).toBe('文字')
    expect(sanitizeHtml('<table><tr><td>格子</td></tr></table>')).toBe('格子')
  })

  it('bra 自闭合标签规范化', () => {
    expect(sanitizeHtml('<p>上<br>下</p>')).toBe('<p>上<br />下</p>')
  })

  it('空输入与非法输入返回空串', () => {
    expect(sanitizeHtml('')).toBe('')
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml(undefined)).toBe('')
    expect(sanitizeHtml(123)).toBe('')
  })

  it('纯文本输入原样通过', () => {
    expect(sanitizeHtml('就是一段普通文字')).toBe('就是一段普通文字')
  })
})

describe('htmlToPlainText 抽纯文本', () => {
  it('去掉标签只留文字', () => {
    expect(htmlToPlainText('<p>你好</p>')).toBe('你好')
    expect(htmlToPlainText('<strong>粗</strong>体')).toBe('粗体')
  })

  it('段落之间保留换行（不能压成一行）', () => {
    expect(htmlToPlainText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n第二段')
  })

  it('br 变成换行', () => {
    expect(htmlToPlainText('上<br />下')).toBe('上\n下')
  })

  it('列表项各占一行', () => {
    expect(htmlToPlainText('<ul><li>一</li><li>二</li></ul>')).toContain('一')
    expect(htmlToPlainText('<ul><li>一</li><li>二</li></ul>')).toContain('二')
  })

  it('还原实体', () => {
    expect(htmlToPlainText('<p>a &amp; b</p>')).toBe('a & b')
    expect(htmlToPlainText('<p>&lt;标签&gt;</p>')).toBe('<标签>')
  })

  it('压缩过多空行：连续三个 br 也只留一个空行', () => {
    expect(htmlToPlainText('上<br /><br /><br />下')).toBe('上\n\n下')
  })

  it('空段落不产生多余空行', () => {
    expect(htmlToPlainText('<p>上</p><p></p><p>下</p>')).toBe('上\n下')
  })

  it('空输入返回空串', () => {
    expect(htmlToPlainText('')).toBe('')
  })
})

describe('toPlainText 兼容旧数据', () => {
  it('没有格式标记时按纯文本处理，原样返回', () => {
    // 这是旧数据的路径：整个升级过程不改写任何旧记录
    expect(toPlainText('旧备忘原文', undefined)).toBe('旧备忘原文')
    expect(toPlainText('旧备忘原文')).toBe('旧备忘原文')
    expect(toPlainText('旧备忘原文', 'plain')).toBe('旧备忘原文')
  })

  it('纯文本里的 < 不会被当成标签吃掉', () => {
    expect(toPlainText('a < b 且 c > d')).toBe('a < b 且 c > d')
  })

  it('标记为 rich 时才剥标签', () => {
    expect(toPlainText('<p>富文本</p>', 'rich')).toBe('富文本')
  })

  it('非字符串输入得到空串而不是崩溃', () => {
    expect(toPlainText(undefined, 'rich')).toBe('')
    expect(toPlainText(null, 'rich')).toBe('')
  })
})

describe('isRichContent', () => {
  it('只有 rich 算富文本', () => {
    expect(isRichContent('rich')).toBe(true)
    expect(isRichContent('plain')).toBe(false)
    expect(isRichContent(undefined)).toBe(false)
    expect(isRichContent(null)).toBe(false)
    expect(isRichContent('RICH')).toBe(false)
  })
})

describe('normalizeRichText 宽容规范化', () => {
  it('旧数据（无标记）原样保留，连行尾空白也不动', () => {
    const result = normalizeRichText('多行\n内容  ', undefined)
    expect(result).toEqual({ text: '多行\n内容  ' })
    expect(result.contentFormat).toBeUndefined()
  })

  it('富文本会净化并带标记', () => {
    const result = normalizeRichText('<p>正文</p><script>x</script>', 'rich')
    expect(result.contentFormat).toBe('rich')
    expect(result.text).toBe('<p>正文</p>')
  })

  it('净化后只剩空内容时视为空', () => {
    expect(normalizeRichText('<script>alert(1)</script>', 'rich')).toEqual({
      text: '',
      contentFormat: 'rich'
    })
    expect(normalizeRichText('<p></p>', 'rich')).toEqual({ text: '', contentFormat: 'rich' })
  })

  it('空输入返回空文本', () => {
    expect(normalizeRichText('', 'rich')).toEqual({ text: '' })
    expect(normalizeRichText(null, 'rich')).toEqual({ text: '' })
  })

  it('非字符串输入不抛错', () => {
    expect(() => normalizeRichText({ a: 1 }, 'rich')).not.toThrow()
  })
})
