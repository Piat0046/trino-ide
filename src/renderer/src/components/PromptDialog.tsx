import { useState, type FormEvent } from 'react'
import { useEscClose } from '../lib/useEscClose'

interface Props {
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

/**
 * 이름 입력용 모달. Electron renderer는 window.prompt를 지원하지 않으므로
 * prompt가 필요한 곳(폴더/쿼리 이름 등)에서 이 컴포넌트를 사용한다.
 */
export function PromptDialog({
  title,
  initialValue = '',
  placeholder,
  confirmLabel = '확인',
  onSubmit,
  onClose
}: Props): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const valid = value.trim().length > 0
  useEscClose(onClose)

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!valid) return
    onSubmit(value.trim())
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>{title}</h2>
        <label>
          이름
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoFocus
            required
          />
        </label>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
