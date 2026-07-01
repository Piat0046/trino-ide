import { IconPlus, IconSplit, IconX } from './icons'

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
}

export function EditorTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  split,
  onToggleSplit
}: Props): JSX.Element {
  return (
    <div className="tabstrip">
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
      <button className="tab-new" title="새 탭" onClick={onNew}>
        <IconPlus size={15} />
      </button>
      <span className="tab-strip-spacer" />
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
    </div>
  )
}
