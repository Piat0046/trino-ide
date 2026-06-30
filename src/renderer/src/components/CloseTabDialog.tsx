interface Props {
  tabTitle: string
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** 저장 안 한 변경이 있는 탭을 닫을 때의 3버튼 확인. window.confirm은 2버튼이라 부적합. */
export function CloseTabDialog({ tabTitle, onSave, onDiscard, onCancel }: Props): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>변경 사항 저장</h2>
        <p style={{ margin: 0, color: 'var(--text-1)', fontSize: 13, lineHeight: 1.6 }}>
          <strong>{tabTitle}</strong> 에 저장하지 않은 변경이 있습니다. 닫기 전에 저장할까요?
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <span className="spacer" />
          <button className="danger" onClick={onDiscard}>
            저장 안 함
          </button>
          <button className="primary" onClick={onSave}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
