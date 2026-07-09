import { IconBookmark, IconClock, IconDatabase, IconLayers, IconSitemap } from './icons'

export type ExplorerSection = 'connections' | 'saved' | 'history' | 'metadata' | 'browser'

interface Props {
  active: ExplorerSection
  /** 사이드바가 접혀 있으면 활성 하이라이트를 표시하지 않는다 */
  collapsed?: boolean
  onChange: (section: ExplorerSection) => void
}

const ITEMS: { key: ExplorerSection; label: string; icon: JSX.Element }[] = [
  { key: 'connections', label: 'Connections', icon: <IconDatabase /> },
  { key: 'saved', label: 'Saved queries', icon: <IconBookmark /> },
  { key: 'history', label: 'History', icon: <IconClock /> },
  { key: 'metadata', label: 'Metadata', icon: <IconLayers /> },
  { key: 'browser', label: 'Browser (서버 탐색)', icon: <IconSitemap /> }
]

export function ActivityRail({ active, collapsed = false, onChange }: Props): JSX.Element {
  return (
    <nav className="rail">
      {ITEMS.map((it) => {
        const isActive = active === it.key && !collapsed
        return (
          <button
            key={it.key}
            className={'rail-btn' + (isActive ? ' active' : '')}
            title={it.label}
            aria-label={it.label}
            aria-pressed={isActive}
            onClick={() => onChange(it.key)}
          >
            {it.icon}
          </button>
        )
      })}
      <span className="rail-spacer" />
    </nav>
  )
}
