import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { autocompletion } from '@codemirror/autocomplete'
import type { HostConfig } from '@shared/types'
import { cmTheme } from '../lib/cmTheme'
import { activeStatement } from '../lib/cmActiveStatement'
import { trino } from '../lib/trinoDialect'
import { statementAtCursor } from '../lib/sqlStatements'
import { formatSql } from '../lib/formatSql'
import { IconFormat, IconPlay, IconSave, IconStop } from './icons'
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
  /** 실행할 SQL(커서가 놓인 문장 하나) */
  onRun: (sql: string) => void
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
  // 세로 분할 토글(탭 스트립 우상단)
  split?: boolean
  onToggleSplit?: () => void
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
  onRowLimitChange,
  split,
  onToggleSplit
}: Props): JSX.Element {
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const unlimited = rowLimit === null
  const [limitText, setLimitText] = useState(unlimited ? String(FALLBACK_LIMIT) : String(rowLimit))

  useEffect(() => {
    if (rowLimit !== null) setLimitText(String(rowLimit))
  }, [rowLimit])

  /** 커서가 놓인 문장 본문. view가 없으면 전체 텍스트로 폴백. */
  const activeStatementText = (): string => {
    const view = cmRef.current?.view
    if (!view) return sqlText
    const doc = view.state.doc.toString()
    return statementAtCursor(doc, view.state.selection.main.head)?.text ?? ''
  }

  const handleRun = (): void => {
    if (running || !hostId) return
    const stmt = activeStatementText()
    if (!stmt.trim()) return
    onRun(stmt)
  }

  const handleFormat = (): void => {
    const view = cmRef.current?.view
    if (!view) return
    const current = view.state.doc.toString()
    const formatted = formatSql(current)
    if (formatted === current) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } })
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      handleFormat()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRun()
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
    <div className={'editor-pane' + (split ? ' compact' : '')} onKeyDown={handleKeyDown}>
      <EditorTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNew={onNewTab}
        split={split}
        onToggleSplit={onToggleSplit}
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
          <label className="limit-unlimited" title="LIMIT 없이 받되 안전상 최대 5만 행까지 표시">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => handleToggleUnlimited(e.target.checked)}
            />
            <span className="limit-unlimited-text">제한하지 않음</span>
          </label>
        </div>

        <button onClick={handleFormat} disabled={!sqlText.trim()} title="포맷 (⇧⌘F)">
          <IconFormat size={14} />
          <span className="btn-label">포맷</span>
        </button>
        <button
          onClick={onSave}
          disabled={!sqlText.trim()}
          title={isScratch ? '다른 이름으로 저장 (⌘S)' : '현재 쿼리에 저장 (⌘S)'}
        >
          <IconSave size={14} />
          <span className="btn-label">저장</span>
        </button>
        {running ? (
          <button className="danger" onClick={onCancel} title="실행 중지">
            <IconStop size={13} />
            <span className="btn-label">중지</span>
          </button>
        ) : (
          <button
            className="primary"
            onClick={handleRun}
            disabled={!hostId}
            title="현재 문장 실행 (⌘↵)"
          >
            <IconPlay size={13} />
            <span className="btn-label">실행</span>
          </button>
        )}
      </div>

      <div className="cm-host">
        <CodeMirror
          ref={cmRef}
          value={sqlText}
          height="100%"
          theme="dark"
          extensions={[
            trino,
            cmTheme,
            activeStatement,
            autocompletion({ activateOnTyping: true, selectOnOpen: false })
          ]}
          onChange={onChange}
        />
      </div>
    </div>
  )
}
