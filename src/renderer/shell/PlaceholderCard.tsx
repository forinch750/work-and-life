/**
 * "待开发"模块的说明卡（PRD §2.2）
 *
 * 点进去不是空白页：说清它是干什么的、计划做哪些功能、第几版提供。
 * 底部不放任何按钮，避免误导成"现在就能用"。
 */
import type { PlaceholderContent } from '../../shared/placeholderContent'

export interface PlaceholderCardProps {
  moduleLabel: string
  plannedVersion: string
  content: PlaceholderContent
}

export function PlaceholderCard({
  moduleLabel,
  plannedVersion,
  content
}: PlaceholderCardProps): React.JSX.Element {
  return (
    <div className="page" data-testid="placeholder-page">
      <header className="page__header">
        <div className="page__heading">
          <h1 className="page__title">
            {moduleLabel}
            <span className="page__title-tag">待开发</span>
          </h1>
          <p className="page__description">{content.summary}</p>
        </div>
      </header>

      <div className="page__content">
        <div className="panel">
          <h2 className="panel__title">计划中的核心功能</h2>
          <ul className="feature-list">
            {content.features.map((feature) => (
              <li key={feature.title} className="feature-list__item">
                <span className="feature-list__title">{feature.title}</span>
                <span className="feature-list__detail">{feature.detail}</span>
              </li>
            ))}
          </ul>
          <p className="panel__note">
            计划在{plannedVersion}提供，你的其它数据不受影响。
          </p>
        </div>
      </div>
    </div>
  )
}
