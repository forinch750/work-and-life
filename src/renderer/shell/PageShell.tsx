/**
 * 模块页统一骨架（PRD §2.3 / DEVPLAN 阶段 2）
 *
 * 规矩：
 *   - 页头：模块名 + 一句话说明 + 唯一主操作按钮
 *   - 工具条：筛选/切换、搜索、排序
 *   - 内容区：各模块自己决定
 * 次要操作（删除、归档、导出）不放页头，藏在条目菜单或详情里。
 */

export interface PageShellProps {
  title: string
  /**
   * 页头那句话（`逾期 N 项 · 今天 N 项 · 本周 N 项` 这类）。
   *
   * 允许传节点（不只是字符串）：计划页要把「逾期 N 项」那一段在 > 0 时标出来
   * （修改 5 轮关掉自动顺延之后，它是唯一的常驻提醒手段）。
   * 包成 `<span>` 不改变 `textContent`，验收照旧按整句读。
   */
  description?: React.ReactNode
  /** 页头唯一的主操作按钮 */
  primaryAction?: { label: string; onClick: () => void; testId?: string }
  /** 工具条内容 */
  toolbar?: React.ReactNode
  /**
   * 内容区吃满剩余高度（默认 false）。
   *
   * 给"主体必须内部滚动、页面级不许出滚动条"的页面用（日历三档，§5.9 / §7.2），
   * 列表类页面保持 false：它们本来就该按内容长、由工作区统一滚。
   */
  fill?: boolean
  /**
   * 下区跟随整页滚（默认 false；学习 / 复习 / 读书三页用）。
   *
   * 2026-10 修订（`MASTER.md` §7.2 / 决定 7）：用户要求"滚动整个页面时下区跟着往下翻，
   * 而不是困在一小块里"。落地方式是**让右侧内容区（`.workspace`）成为滚动容器**，
   * 下区按内容高、不再内部滚——见 `styles/layout.css` 的 `page--scroll` 一节。
   *
   * 与 `fill` 一起用：`fill` 保留"高度链条一路传下去"的语义，
   * `scroll` 再把链条末端放开（下区按内容长）。**不要**单独用 `scroll`。
   */
  scroll?: boolean
  children: React.ReactNode
}

export function PageShell({
  title,
  description,
  primaryAction,
  toolbar,
  fill = false,
  scroll = false,
  children
}: PageShellProps): React.JSX.Element {
  return (
    <div
      className={`page${fill ? ' page--fill' : ''}${scroll ? ' page--scroll' : ''}`}
      data-testid="page"
    >
      <header className="page__header">
        <div className="page__heading">
          <h1 className="page__title">{title}</h1>
          {description ? (
            // testid 是给验收读的（计划页的"逾期 N 项 · 今天 N 项 · 本周 N 项"要按数核对）；
            // 可见文案不变，样式仍走 .page__description
            <p className="page__description" data-testid="page-description">
              {description}
            </p>
          ) : null}
        </div>
        {primaryAction ? (
          <button
            type="button"
            className="button button--primary"
            data-testid={primaryAction.testId ?? 'page-primary-action'}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </button>
        ) : null}
      </header>

      {toolbar ? <div className="page__toolbar">{toolbar}</div> : null}

      <div className="page__content">{children}</div>
    </div>
  )
}
