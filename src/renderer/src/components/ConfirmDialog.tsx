import { useEscClose } from '../lib/useEscClose'

export interface ConfirmConfig {
  title: string
  message?: string
  confirmLabel?: string
  /** 파괴적 작업이면 확인 버튼을 빨강으로 */
  danger?: boolean
  onConfirm: () => void
}

interface Props extends ConfirmConfig {
  onCancel: () => void
}

/** 네이티브 window.confirm 대체(다크 테마·Esc·포커스·ARIA). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '확인',
  danger,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  useEscClose(onCancel)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {message && <p className="modal-msg">{message}</p>}
        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <span className="spacer" />
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
