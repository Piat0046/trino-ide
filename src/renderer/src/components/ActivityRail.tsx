import { IconBookmark, IconClock, IconDatabase } from './icons'

export type ExplorerSection = 'connections' | 'saved' | 'history'

interface Props {
  active: ExplorerSection
  onChange: (section: ExplorerSection) => void
}

const ITEMS: { key: ExplorerSection; label: string; icon: JSX.Element }[] = [
  { key: 'connections', label: 'Connections', icon: <IconDatabase /> },
  { key: 'saved', label: 'Saved queries', icon: <IconBookmark /> },
  { key: 'history', label: 'History', icon: <IconClock /> }
]

export function ActivityRail({ active, onChange }: Props): JSX.Element {
  return (
    <nav className="rail">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          className={'rail-btn' + (active === it.key ? ' active' : '')}
          title={it.label}
          aria-label={it.label}
          aria-pressed={active === it.key}
          onClick={() => onChange(it.key)}
        >
          {it.icon}
        </button>
      ))}
      <span className="rail-spacer" />
    </nav>
  )
}
