import { useState, type FormEvent } from 'react'
import { useEscClose } from '../lib/useEscClose'
import { TRINO_TYPES } from '../lib/trinoWords'

interface Props {
  /** 부모 테이블 경로(표시용) */
  parent: string
  initialName?: string
  initialType?: string
  editing?: boolean
  onSubmit: (name: string, type: string) => void
  onClose: () => void
}

/** 수동 컬럼 추가/편집 모달. 이름 + 타입(TRINO_TYPES 자동완성). */
export function ColumnEditDialog({
  parent,
  initialName = '',
  initialType = '',
  editing = false,
  onSubmit,
  onClose
}: Props): JSX.Element {
  const [name, setName] = useState(initialName)
  const [type, setType] = useState(initialType)
  const valid = name.trim().length > 0
  useEscClose(onClose)

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!valid) return
    onSubmit(name.trim(), type.trim())
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? '컬럼 편집' : '컬럼 추가'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>{editing ? '컬럼 편집' : '컬럼 추가'}</h2>
        <div className="modal-msg">{parent}</div>
        <label>
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="컬럼 이름"
            autoFocus
            required
          />
        </label>
        <label>
          타입
          <input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="예: varchar, bigint (선택)"
            list="trino-type-list"
          />
        </label>
        <datalist id="trino-type-list">
          {TRINO_TYPES.map((t) => (
            <option key={t} value={t.toUpperCase()} />
          ))}
        </datalist>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            저장
          </button>
        </div>
      </form>
    </div>
  )
}
