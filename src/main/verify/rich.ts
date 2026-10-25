/**
 * 富文本编辑器在验收台里的驱动（第 04 块 / FEAT-002）
 *
 * 为什么单独一份：本块的五个正文类字段从 `<textarea>` 换成了 contentEditable，
 * 而验收台原来的 `window.__verify.setText` 走的是 `HTMLTextAreaElement.prototype.value`
 * 的原生 setter——**对 contentEditable 不成立**（div 上没有 value，
 * 写进去也不会触发 React 的 onChange，最后保存下来的会是一条空记录）。
 *
 * 这里给出正确的触发方式，两条路都试：
 *   1. `document.execCommand('insertHTML')`：走浏览器真实编辑管线，
 *      会派发真实的 input 事件（也就是"用户真的输入了"）
 *   2. 万一 execCommand 被拦下（返回值 false 或内容没进去），
 *      退回"写 DOM + 派发 InputEvent"——React 的 onInput 同样会收到
 *
 * 另外给了一个读显示结果的助手：正文显示走 `RichTextView`，
 * 它会挂 `data-content-format` / `data-has-links`，验收直接读这两个属性，
 * 不用去猜"页面上看起来对不对"。
 */
import type { VerifyContext } from './runner'

/** 注入渲染进程的富文本助手（挂在 window.__rich 上，与 __verify 分开，互不覆盖） */
const RICH_HELPERS = `
  window.__rich = {
    set: function (id, html) {
      const el = document.querySelector('[data-testid="' + id + '"]')
      if (!el) return false
      if (el.isContentEditable !== true) return false
      el.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
      let inserted = false
      try {
        inserted = document.execCommand('insertHTML', false, html) === true
      } catch (error) {
        inserted = false
      }
      // 内容没进去也要兜底（execCommand 在个别环境里返回 true 却不生效）
      if (!inserted || el.innerHTML.trim() === '') {
        el.innerHTML = html
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      selection.removeAllRanges()
      el.blur()
      return true
    },
    /** 在编辑器里点一下工具条按钮（加粗等），验证工具条真的接到了页面 */
    tool: function (editorId, tool) {
      const button = document.querySelector('[data-testid="' + editorId + '-' + tool + '"]')
      if (!button) return false
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      return true
    },
    /** 全选编辑器里的内容（配合 tool 用：先全选、再点加粗） */
    selectAll: function (id) {
      const el = document.querySelector('[data-testid="' + id + '"]')
      if (!el) return false
      el.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    },
    /**
     * "全选 + 点工具条加粗"必须在**同一次脚本执行**里做完。
     *
     * 分两次 executeJavaScript 调用的风险是选区在两次调用之间丢失
     * （窗口没拿到焦点时尤其明显），那样 execCommand('bold') 作用在空选区上，
     * 加粗不生效——看起来像"工具条坏了"，其实只是驱动方式不对。
     */
    boldViaToolbar: function (editorId) {
      const el = document.querySelector('[data-testid="' + editorId + '"]')
      if (!el) return false
      el.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
      const button = document.querySelector('[data-testid="' + editorId + '-bold"]')
      if (!button) return false
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      return true
    },
    /** 编辑器当前内容（innerHTML） */
    html: function (id) {
      const el = document.querySelector('[data-testid="' + id + '"]')
      return el ? el.innerHTML : null
    },
    /** 某个显示块的内容格式与链接标记（RichTextView 挂的 data-*） */
    display: function (id) {
      const el = document.querySelector('[data-testid="' + id + '"]')
      if (!el) return null
      const html = el.innerHTML
      return {
        text: (el.textContent || '').trim(),
        format: el.getAttribute('data-content-format') || '',
        hasLinks: el.getAttribute('data-has-links') === 'true',
        // 渲染出来的 DOM 里有没有可跳转的 anchor
        anchors: el.querySelectorAll('a[href]').length,
        hasHref: /\\shref\\s*=/.test(html),
        hasLinkHint: !!el.querySelector('.rich-text__link-hint')
      }
    }
  }
  'rich-helpers-ready'
`

export interface RichDisplaySnapshot {
  text: string
  format: string
  hasLinks: boolean
  /** 带 href 的 <a> 个数：**必须为 0**（链接只能存不能点开） */
  anchors: number
  hasHref: boolean
  hasLinkHint: boolean
}

async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

/** 注入助手（幂等；每个阶段自己注入一次，不依赖别的阶段留下的状态） */
export async function injectRichHelpers(context: VerifyContext): Promise<void> {
  await evaluate(context, RICH_HELPERS)
}

/** 把内容真的"输入"到某个富文本编辑器里 */
export async function setRichHtml(
  context: VerifyContext,
  id: string,
  html: string
): Promise<boolean> {
  return evaluate<boolean>(context, `window.__rich.set(${JSON.stringify(id)}, ${JSON.stringify(html)})`)
}

/** 点一下编辑器工具条上的某个按钮（bold / italic / h2 …） */
export async function clickRichTool(
  context: VerifyContext,
  editorId: string,
  tool: string
): Promise<boolean> {
  return evaluate<boolean>(
    context,
    `window.__rich.tool(${JSON.stringify(editorId)}, ${JSON.stringify(tool)})`
  )
}

/** 全选编辑器里的内容（先全选、再点工具条，等价于"选中一段字再加粗"） */
export async function selectRichAll(context: VerifyContext, id: string): Promise<boolean> {
  return evaluate<boolean>(context, `window.__rich.selectAll(${JSON.stringify(id)})`)
}

/**
 * "选中全部内容 + 点工具条的加粗"一次做完（选区不会跨调用丢失）。
 *
 * 验收里用它验证工具条**真的接到了页面**：点了以后编辑器里要出现
 * `<b>` / `<strong>`，落库也要是富文本——而不是"按钮画在屏幕上"。
 */
export async function boldViaToolbar(context: VerifyContext, editorId: string): Promise<boolean> {
  return evaluate<boolean>(context, `window.__rich.boldViaToolbar(${JSON.stringify(editorId)})`)
}

/** 读编辑器当前内容 */
export async function readRichHtml(context: VerifyContext, id: string): Promise<string | null> {
  return evaluate<string | null>(context, `window.__rich.html(${JSON.stringify(id)})`)
}

/** 读某个显示块（RichTextView）的格式与链接状态 */
export async function readRichDisplay(
  context: VerifyContext,
  id: string
): Promise<RichDisplaySnapshot | null> {
  return evaluate<RichDisplaySnapshot | null>(
    context,
    `window.__rich.display(${JSON.stringify(id)})`
  )
}
