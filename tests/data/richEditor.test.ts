/**
 * 编辑器侧 HTML 规范化的单测（第 04 块）
 *
 * 这一组盯的是接页面时发现的**真缺陷**：contentEditable 里回车产生的是
 * `<div>` 换行包装，而净化白名单里没有 `div`，直接落库会把换行整段丢掉
 * （多行备忘被压成一行）。修法见 `richText.normalizeEditorHtml` 的注释：
 * 把 `div` 换成白名单里的 `p`，**不改净化规则**。
 *
 * 所以这里第二条断言特别重要：`sanitizeHtml` 对 `<div>` 的既有行为没变
 * （仍然脱壳），既有的 35 项净化单测因此一条都不用改。
 */
import { describe, expect, it } from 'vitest'
import {
  htmlToPlainText,
  normalizeEditorHtml,
  normalizeRichText,
  sanitizeHtml
} from '../../src/shared/richText'

describe('normalizeEditorHtml · contentEditable 的换行包装', () => {
  it('把行包装 <div> 换成白名单里的 <p>', () => {
    expect(normalizeEditorHtml('<div>第一行</div><div>第二行</div>')).toBe(
      '<p>第一行</p><p>第二行</p>'
    )
  })

  it('规范化之后，换行在落库与抽纯文本这两步都保得住', () => {
    const saved = normalizeRichText(normalizeEditorHtml('<div>第一行</div><div>第二行</div>'), 'rich')
    expect(saved.text).toBe('<p>第一行</p><p>第二行</p>')
    expect(htmlToPlainText(saved.text)).toBe('第一行\n第二行')
  })

  it('对照：不先规范化就会丢掉换行（这就是当初的 bug）', () => {
    // 这条不是在测"正确行为"，而是把缺陷本身钉住：
    // 谁要是删掉 normalizeEditorHtml 的调用，多行内容就会重新被压成一行
    expect(sanitizeHtml('<div>第一行</div><div>第二行</div>')).toBe('第一行第二行')
  })

  it('混合内容：行首纯文本 + 后面的行包装', () => {
    const out = normalizeEditorHtml('第一行<div>第二行</div>')
    expect(htmlToPlainText(normalizeRichText(out, 'rich').text)).toBe('第一行\n第二行')
  })

  it('styleWithCSS 产生的加粗/斜体/下划线换成等价的行内标签', () => {
    expect(normalizeEditorHtml('<span style="font-weight: bold">粗</span>')).toBe('<b>粗</b>')
    expect(normalizeEditorHtml('<span style="font-weight: 700">粗</span>')).toBe('<b>粗</b>')
    expect(normalizeEditorHtml('<span style="font-style: italic">斜</span>')).toBe('<i>斜</i>')
    expect(normalizeEditorHtml('<span style="text-decoration: underline">线</span>')).toBe('<u>线</u>')
  })

  it('别的 span（纯样式容器）只脱壳，文字保留', () => {
    expect(normalizeEditorHtml('<span style="color: red">红字</span>')).toBe('红字')
    expect(normalizeEditorHtml('<span>裸 span</span>')).toBe('裸 span')
  })

  it('现有标签原样保留（不会顺手改动别的东西）', () => {
    const html = '<p>段</p><ul><li>项</li></ul><blockquote>引</blockquote><pre>码</pre>'
    expect(normalizeEditorHtml(html)).toBe(html)
  })

  it('空与非字符串输入不抛错', () => {
    expect(normalizeEditorHtml('')).toBe('')
    expect(normalizeEditorHtml(undefined)).toBe('')
    expect(normalizeEditorHtml(null)).toBe('')
    expect(normalizeEditorHtml(12)).toBe('')
  })

  it('规范化之后再净化，危险内容仍然拦得住（没有绕开 sanitizeHtml）', () => {
    const dirty = '<div>正文</div><script>alert(1)</script>'
    const safe = normalizeRichText(normalizeEditorHtml(dirty), 'rich').text
    expect(safe).not.toContain('script')
    expect(safe).not.toContain('alert')
    expect(safe).toContain('正文')
  })
})
