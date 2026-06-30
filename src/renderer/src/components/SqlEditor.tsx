import { useEffect, useState, type KeyboardEvent } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import type { HostConfig } from '@shared/types'
import { cmTheme } from '../lib/cmTheme'
import { IconPlay, IconSave, IconStop } from './icons'
import { EditorTabs, type TabView } from './EditorTabs'

interface Props {
  // tabs
  tabs: TabView[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  // active editor
  sql: string
  onChange: (value: string) => void
  onRun: () => void
  onCancel: () => void
  onSave: () => void
  running: boolean
  /** 활성 탭이 미저장 스크래치인지 (저장 버튼 의미 분기) */
  isScratch: boolean
  // connection (활성 탭에 귀속)
  hosts: HostConfig[]
  hostId: string | null
  onSelectHost: (id: string) => void
  // LIMIT (전역)
  rowLimit: number | null
  onRowLimitChange: (limit: number | null) => void
}

const NUMERIC_PRESETS = ['100', '300', '500', '1000', '5000', '10000']
const FALLBACK_LIMIT = 300

export function SqlEditor({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  sql: sqlText,
  onChange,
  onRun,
  onCancel,
  onSave,
  running,
  isScratch,
  hosts,
  hostId,
  onSelectHost,
  rowLimit,
  onRowLimitChange
}: Props): JSX.Element {
  const unlimited = rowLimit === null
  const [limitText, setLimitText] = useState(unlimited ? String(FALLBACK_LIMIT) : String(rowLimit))

  useEffect(() => {
    if (rowLimit !== null) setLimitText(String(rowLimit))
  }, [rowLimit])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running && hostId) onRun()
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      onSave()
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
      <EditorTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNew={onNewTab}
      />

      <div className="toolbar">
        <select
          className="conn-select"
          value={hostId ?? ''}
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

        <button
          onClick={onSave}
          disabled={!sqlText.trim()}
          title={isScratch ? '다른 이름으로 저장 (⌘S)' : '현재 쿼리에 저장 (⌘S)'}
        >
          <IconSave size={14} />
          저장
        </button>
        {running ? (
          <button className="danger" onClick={onCancel}>
            <IconStop size={13} />
            중지
          </button>
        ) : (
          <button className="primary" onClick={onRun} disabled={!hostId} title="실행 (⌘↵)">
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
