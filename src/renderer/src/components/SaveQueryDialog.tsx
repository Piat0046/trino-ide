import { useState, type FormEvent } from 'react'
import type { QueryFolder } from '@shared/types'
import { useEscClose } from '../lib/useEscClose'

export interface SaveQueryResult {
  name: string
  /** 기존 폴더 id. newFolderName이 있으면 무시 */
  folderId?: string
  /** 새 폴더를 만들 경우의 이름 */
  newFolderName?: string
}

interface Props {
  folders: QueryFolder[]
  /** 저장할 SQL 미리보기용 */
  sqlPreview: string
  onClose: () => void
  onSave: (result: SaveQueryResult) => Promise<void>
}

const NEW_FOLDER = '__new__'

export function SaveQueryDialog({ folders, sqlPreview, onClose, onSave }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState<string>(folders[0]?.id ?? NEW_FOLDER)
  const [newFolderName, setNewFolderName] = useState('')
  const [saving, setSaving] = useState(false)
  useEscClose(onClose)

  const creatingFolder = folderId === NEW_FOLDER || folders.length === 0
  const valid = name.trim().length > 0 && (!creatingFolder || newFolderName.trim().length > 0)

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        folderId: creatingFolder ? undefined : folderId,
        newFolderName: creatingFolder ? newFolderName.trim() : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="쿼리 저장"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>쿼리 저장</h2>

        <label>
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 일별 매출 집계"
            autoFocus
            required
          />
        </label>

        <label>
          폴더
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value={NEW_FOLDER}>＋ 새 폴더…</option>
          </select>
        </label>

        {creatingFolder && (
          <label>
            새 폴더 이름
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="예: 매출 리포트"
              required
            />
          </label>
        )}

        <div className="sql-preview">{sqlPreview.trim() || '(빈 쿼리)'}</div>

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!valid || saving}>
            저장
          </button>
        </div>
      </form>
    </div>
  )
}
