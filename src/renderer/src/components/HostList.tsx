import type { HostConfig } from '@shared/types'

interface Props {
  hosts: HostConfig[]
  selectedHostId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (h: HostConfig) => void
  onDelete: (h: HostConfig) => void
}

export function HostList({
  hosts,
  selectedHostId,
  onSelect,
  onAdd,
  onEdit,
  onDelete
}: Props): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-action">
        <button className="block-btn" onClick={onAdd}>
          ＋ 새 host
        </button>
      </div>
      <ul className="host-list">
        {hosts.length === 0 && <li className="empty">등록된 host가 없습니다.</li>}
        {hosts.map((h) => (
          <li
            key={h.id}
            className={'host-item' + (h.id === selectedHostId ? ' selected' : '')}
            onClick={() => onSelect(h.id)}
          >
            <div className="host-name">{h.name}</div>
            <div className="host-url">{h.url}</div>
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
                  if (confirm(`'${h.name}' host를 삭제할까요?`)) onDelete(h)
                }}
              >
                삭제
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
