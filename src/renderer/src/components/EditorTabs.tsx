import { IconPlus, IconX } from './icons'

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
}

export function EditorTabs({ tabs, activeTabId, onSelect, onClose, onNew }: Props): JSX.Element {
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
    </div>
  )
}
