import { type KeyboardEvent } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import type { HostConfig } from '@shared/types'

interface Props {
  sql: string
  onChange: (value: string) => void
  onRun: () => void
  onCancel: () => void
  onSave: () => void
  running: boolean
  selectedHost: HostConfig | null
}

export function SqlEditor({
  sql: sqlText,
  onChange,
  onRun,
  onCancel,
  onSave,
  running,
  selectedHost
}: Props): JSX.Element {
  // ⌘↵ / Ctrl+↵ 로 실행
  const handleKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running && selectedHost) onRun()
    }
  }

  return (
    <div className="editor" onKeyDown={handleKeyDown}>
      <div className="editor-toolbar">
        <span className="host-indicator">
          {selectedHost ? (
            <>
              <strong>{selectedHost.name}</strong>
              <span className="muted"> · {selectedHost.url}</span>
              {selectedHost.catalog && <span className="muted"> · {selectedHost.catalog}</span>}
              {selectedHost.schema && <span className="muted">.{selectedHost.schema}</span>}
            </>
          ) : (
            <span className="muted">왼쪽에서 host를 선택하세요</span>
          )}
        </span>
        <span className="spacer" />
        <button onClick={onSave} disabled={!sqlText.trim()} title="현재 쿼리를 저장">
          💾 저장
        </button>
        {running ? (
          <button className="danger" onClick={onCancel}>
            중지 ■
          </button>
        ) : (
          <button className="primary" onClick={onRun} disabled={!selectedHost}>
            실행 ▶ (⌘↵)
          </button>
        )}
      </div>
      <CodeMirror
        value={sqlText}
        height="240px"
        theme="dark"
        extensions={[sql()]}
        onChange={onChange}
      />
    </div>
  )
}
