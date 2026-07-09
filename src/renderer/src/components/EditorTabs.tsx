import { IconPanelRight, IconPlus, IconSplit, IconX } from './icons'

export interface TabView {
  id: string
  title: string
  dirty: boolean
}

interface Props {
  tabs: TabView[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** 세로 분할 상태 + 토글(우상단) */
  split?: boolean
  onToggleSplit?: () => void
  /** 우측 인스펙터 사이드바 열림 상태 + 토글 */
  inspectorOpen?: boolean
  onToggleInspector?: () => void
}

export function EditorTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  split,
  onToggleSplit,
  inspectorOpen,
  onToggleInspector
}: Props): JSX.Element {
  return (
    <div className="tabstrip">
      {/* 탭은 넘치면 이 섹션 안에서만 가로 스크롤 */}
      <div className="tabstrip-scroll">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={'tab' + (t.id === activeTabId ? ' active' : '')}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(t.id) // 가운데 클릭으로 닫기
            }}
            title={t.title}
          >
            <span className="tab-name">{t.title}</span>
            <span className="tab-trailing">
              {t.dirty && <span className="tab-dirty">●</span>}
              <button
                className="tab-close"
                title="닫기"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >
                <IconX size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {/* 고정 액션 섹션: 새 탭·분할 토글은 탭 개수와 무관하게 항상 보인다 */}
      <div className="tabstrip-actions">
        <button className="tab-new" title="새 탭" onClick={onNew}>
          <IconPlus size={15} />
        </button>
        {onToggleSplit && (
          <button
            className={'tab-split' + (split ? ' active' : '')}
            title={split ? '한 화면으로 (⌘\\)' : '세로로 나누기 (⌘\\)'}
            aria-pressed={split}
            onClick={onToggleSplit}
          >
            <IconSplit size={15} />
          </button>
        )}
        {onToggleInspector && (
          <button
            className={'tab-split' + (inspectorOpen ? ' active' : '')}
            title={inspectorOpen ? '사이드바 닫기 (⌘⌥B)' : '사이드바 열기 (⌘⌥B)'}
            aria-pressed={inspectorOpen}
            onClick={onToggleInspector}
          >
            <IconPanelRight size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
