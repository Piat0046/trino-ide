import { useEffect, useState, type KeyboardEvent } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import type { HostConfig } from '@shared/types'
import { cmTheme } from '../lib/cmTheme'
import { IconPlay, IconSave, IconStop } from './icons'

interface Props {
  sql: string
  onChange: (value: string) => void
  onRun: () => void
  onCancel: () => void
  onSave: () => void
  running: boolean
  hosts: HostConfig[]
  selectedHostId: string | null
  onSelectHost: (id: string) => void
  /** LIMIT 값. null이면 제한하지 않음(전체 수신) */
  rowLimit: number | null
  onRowLimitChange: (limit: number | null) => void
  /** 에디터 탭에 표시할 쿼리 이름(로드된 저장 쿼리) */
  queryName: string | null
  /** 로드 이후 내용이 바뀌었는지 */
  dirty: boolean
}

const NUMERIC_PRESETS = ['100', '300', '500', '1000', '5000', '10000']
const FALLBACK_LIMIT = 300

export function SqlEditor({
  sql: sqlText,
  onChange,
  onRun,
  onCancel,
  onSave,
  running,
  hosts,
  selectedHostId,
  onSelectHost,
  rowLimit,
  onRowLimitChange,
  queryName,
  dirty
}: Props): JSX.Element {
  const unlimited = rowLimit === null
  const [limitText, setLimitText] = useState(unlimited ? String(FALLBACK_LIMIT) : String(rowLimit))

  useEffect(() => {
    if (rowLimit !== null) setLimitText(String(rowLimit))
  }, [rowLimit])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running && selectedHostId) onRun()
    }
  }

  const handleLimitInput = (value: string): void => {
    setLimitText(value)
    const n = parseInt(value, 10)
    if (Number.isFinite(n) && n > 0) onRowLimitChange(n)
  }
  const handleLimitBlur = (): void => {
    const n = parseInt(limitText, 10)
    if (!(Number.isFinite(n) && n > 0)) setLimitText(unlimited ? limitText : String(rowLimit))
  }
  const handleToggleUnlimited = (checked: boolean): void => {
    if (checked) onRowLimitChange(null)
    else {
      const n = parseInt(limitText, 10)
      onRowLimitChange(Number.isFinite(n) && n > 0 ? n : FALLBACK_LIMIT)
    }
  }

  return (
    <div className="editor-pane" onKeyDown={handleKeyDown}>
      <div className="tabstrip">
        <div className="tab active">
          <span className="tab-name">{queryName ?? 'Untitled query'}</span>
          {dirty && <span className="tab-dirty">•</span>}
        </div>
      </div>

      <div className="toolbar">
        <select
          className="conn-select"
          value={selectedHostId ?? ''}
          onChange={(e) => onSelectHost(e.target.value)}
        >
          <option value="" disabled>
            연결 선택…
          </option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name} — {h.url}
            </option>
          ))}
        </select>

        <span className="spacer" />

        <div className="limit-control">
          <span className="limit-label">LIMIT</span>
          <input
            type="text"
            className="limit-input"
            list="limit-presets"
            value={unlimited ? '' : limitText}
            placeholder={unlimited ? '제한 없음' : ''}
            disabled={unlimited}
            onChange={(e) => handleLimitInput(e.target.value)}
            onBlur={handleLimitBlur}
          />
          <datalist id="limit-presets">
            {NUMERIC_PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <label className="limit-unlimited" title="상한 없이 전체 결과를 받습니다">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => handleToggleUnlimited(e.target.checked)}
            />
            제한하지 않음
          </label>
        </div>

        <button onClick={onSave} disabled={!sqlText.trim()} title="현재 쿼리를 저장">
          <IconSave size={14} />
          저장
        </button>
        {running ? (
          <button className="danger" onClick={onCancel}>
            <IconStop size={13} />
            중지
          </button>
        ) : (
          <button className="primary" onClick={onRun} disabled={!selectedHostId} title="실행 (⌘↵)">
            <IconPlay size={13} />
            실행
          </button>
        )}
      </div>

      <div className="cm-host">
        <CodeMirror
          value={sqlText}
          height="100%"
          theme="dark"
          extensions={[sql(), cmTheme]}
          onChange={onChange}
        />
      </div>
    </div>
  )
}
