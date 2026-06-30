import type { HostConfig } from '@shared/types'

interface Props {
  hosts: HostConfig[]
  selectedHostId: string | null
  onSelect: (id: string) => void
  onEdit: (h: HostConfig) => void
  onDelete: (h: HostConfig) => void
}

export function HostList({ hosts, selectedHostId, onSelect, onEdit, onDelete }: Props): JSX.Element {
  return (
    <div className="panel">
      <ul className="list">
        {hosts.length === 0 && (
          <li className="empty">
            등록된 연결이 없습니다.
            <br />
            상단 + 로 추가하세요.
          </li>
        )}
        {hosts.map((h) => (
          <li
            key={h.id}
            className={'host-item' + (h.id === selectedHostId ? ' selected' : '')}
            onClick={() => onSelect(h.id)}
          >
            <div className="host-top">
              <span className="host-dot" />
              <span className="host-name">{h.name}</span>
              <div className="row-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(h)
                  }}
                >
                  편집
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`'${h.name}' 연결을 삭제할까요?`)) onDelete(h)
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
            <div className="host-url">{h.url}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
