import { IconInfo, IconSparkles } from './icons'

export type InspectorTab = 'details' | 'assistant'

interface Props {
  active: InspectorTab
  /** 사이드바가 접혀 있으면 활성 하이라이트를 표시하지 않는다 */
  collapsed?: boolean
  /** 아이콘 클릭: 접혀 있거나 다른 탭이면 그 탭으로 펼침, 활성 탭 재클릭이면 접기 */
  onSelect: (tab: InspectorTab) => void
}

const ITEMS: { key: InspectorTab; label: string; icon: JSX.Element }[] = [
  { key: 'details', label: 'Details (레코드 상세)', icon: <IconInfo /> },
  { key: 'assistant', label: 'Assistant (준비중)', icon: <IconSparkles /> }
]

/** 우측 인스펙터 미니레일(좌측 ActivityRail 대칭). 아이콘 자체가 토글 + 탭 전환. */
export function RightRail({ active, collapsed = false, onSelect }: Props): JSX.Element {
  return (
    <nav className="rail rail-right">
      {ITEMS.map((it) => {
        const isActive = active === it.key && !collapsed
        return (
          <button
            key={it.key}
            className={'rail-btn' + (isActive ? ' active' : '')}
            title={it.label}
            aria-label={it.label}
            aria-pressed={isActive}
            onClick={() => onSelect(it.key)}
          >
            {it.icon}
          </button>
        )
      })}
      <span className="rail-spacer" />
    </nav>
  )
}
