import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { autocompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import type { HostConfig, HostMetadata } from '@shared/types'
import { cmTheme } from '../lib/cmTheme'
import { activeStatement } from '../lib/cmActiveStatement'
import { makeTrino, type CompletionMeta } from '../lib/trinoDialect'
import { resolveRunTarget, type RunTarget } from '../lib/sqlStatements'
import { largeScanRisk, type LargeScanRisk } from '../lib/largeScan'
import { formatSql } from '../lib/formatSql'
import {
  scanParams,
  applyParams,
  paramsReady,
  type ParamValue,
  type ParamType,
  type KindMap
} from '../lib/queryParams'
import { paramHighlight } from '../lib/cmParams'

/** 파라미터 슬롯(owner = 저장쿼리id 또는 스크래치 마커 — 탭 재사용 시 오염 방지). */
interface ParamSlot {
  owner: string
  /** 파라미터 값(def.key → 값) */
  values: Record<string, ParamValue>
  /** 위젯에서 선택한 타입 오버라이드(def.key → 타입) */
  types: Record<string, ParamType>
}
import { IconAlertTriangle, IconFormat, IconPlay, IconSave, IconStop } from './icons'
import { EditorTabs, type TabView } from './EditorTabs'
import { ParamBar } from './ParamBar'
import { EnvBadge, envColor } from './EnvBadge'

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
  /** 바인딩된 저장 쿼리 id(파라미터 값 localStorage 영속 키). 스크래치면 null */
  savedQueryId: string | null
  /** 경량 알림(토스트) */
  onNotify?: (msg: string) => void
  // connection (활성 탭에 귀속)
  hosts: HostConfig[]
  hostId: string | null
  onSelectHost: (id: string) => void
  /** 활성 host의 학습된 메타데이터(자동완성 소스가 읽음) */
  metadata: HostMetadata | null
  // 세로 분할 토글(탭 스트립 우상단)
  split?: boolean
  onToggleSplit?: () => void
}

/** LIMIT 미지정 경고 문구(심각도 등급별). LIMIT을 SQL에 쓰면 서버 pushdown으로 부하가 준다는 걸 앞세운다. */
const SCAN_WARN_COPY: Record<Exclude<LargeScanRisk, null>, string> = {
  starNoWhere:
    'LIMIT·WHERE 없이 SELECT *를 실행하면 서버가 테이블 전체를 스캔·전송합니다. SQL에 LIMIT을 추가하거나 WHERE로 범위를 좁히고 필요한 컬럼만 명시하세요. (화면엔 5만 행 안전 상한까지만 받지만, 서버 부하는 그 전에 커질 수 있어요.)',
  noWhere:
    'LIMIT·WHERE 없이 실행하면 서버가 테이블 전체를 스캔합니다. SQL에 LIMIT을 추가하거나 WHERE로 범위를 좁히세요.',
  star: 'LIMIT 없이 SELECT *를 실행하면 서버가 모든 컬럼을 전부 전송합니다. SQL에 LIMIT을 추가하거나 필요한 컬럼만 명시하세요.',
  noLimit:
    '이 문장에 LIMIT이 없어 서버가 조건에 맞는 행을 전부 계산·전송합니다. WHERE로 이미 좁혔다면 무시해도 되지만, SQL에 LIMIT을 추가하면 서버가 그만큼만 반환합니다.'
}

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
  savedQueryId,
  onNotify,
  hosts,
  hostId,
  onSelectHost,
  metadata,
  split,
  onToggleSplit
}: Props): JSX.Element {
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const editorPaneRef = useRef<HTMLDivElement>(null)
  const currentHost = hosts.find((h) => h.id === hostId) ?? null
  const envSignal = envColor(currentHost?.env)

  // 자동완성 소스가 매 호출 읽는 현재 host 메타데이터(ref만 갱신, 확장 인스턴스는 고정 → reconfigure churn 방지)
  const metaRef = useRef<CompletionMeta>({ meta: null })
  useEffect(() => {
    const host = hosts.find((h) => h.id === hostId)
    metaRef.current = { meta: metadata, defCatalog: host?.catalog, defSchema: host?.schema }
  }, [metadata, hostId, hosts])
  const trinoSupport = useMemo(() => makeTrino(() => metaRef.current), [])

  // 실행 대상(선택 우선, 없으면 커서 문장)을 추적 — 실행·대용량 경고·활성 하이라이트가 공유하는 단일 소스.
  const [runTarget, setRunTarget] = useState<RunTarget>({
    mode: 'statement',
    text: '',
    spansMultiple: false
  })
  const runTargetListener = useMemo(
    () =>
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.selectionSet) {
          const sel = u.state.selection.main
          setRunTarget(resolveRunTarget(u.state.doc.toString(), sel.from, sel.to, sel.head))
        }
      }),
    []
  )
  // 초기/탭 전환 시 시드(타이핑·커서 중 갱신은 updateListener가 담당하므로 activeTabId에만 의존)
  useEffect(() => {
    const view = cmRef.current?.view
    if (view) {
      const sel = view.state.selection.main
      setRunTarget(resolveRunTarget(view.state.doc.toString(), sel.from, sel.to, sel.head))
    }
  }, [activeTabId])
  // 실행 불가(여러 문장 걸침) 상태에선 대용량 경고를 숨겨 모순 메시지를 피한다.
  const scanRisk = runTarget.spansMultiple ? null : largeScanRisk(runTarget.text)
  const runTitle = runTarget.spansMultiple
    ? '선택 영역이 여러 문장에 걸쳐 있어 실행할 수 없어요 — 문장 하나만 선택하세요'
    : runTarget.mode === 'selection'
      ? '선택 영역 실행 (⌘↵)'
      : '현재 문장 실행 (⌘↵)'

  // ----- 쿼리 파라미터({{name}}) -----
  // 값은 탭별 세션 메모리 + 저장쿼리는 localStorage로 프리필. 순수 렌더러(서버 왕복 0).
  // 슬롯마다 owner(=저장쿼리id 또는 스크래치 마커)를 달아, #42 탭 재사용으로 같은 tabId에
  // 다른 쿼리가 들어오면 owner 불일치로 재로딩한다(잔여값 오염 방지).
  const paramDefs = useMemo(
    () => (runTarget.spansMultiple ? [] : scanParams(runTarget.text)),
    [runTarget.text, runTarget.spansMultiple]
  )
  const paramOwner = savedQueryId ?? 'scratch:' + activeTabId
  const [paramStore, setParamStore] = useState<Record<string, ParamSlot>>({})
  // ref 미러 — ⌘↵가 같은 이벤트에서 방금 커밋된 값을 stale 없이 읽도록(멀티 칩 draft 포함)
  const storeRef = useRef(paramStore)
  const writeStore = (next: Record<string, ParamSlot>): void => {
    storeRef.current = next
    setParamStore(next)
  }
  const emptySlot: ParamSlot = { owner: paramOwner, values: {}, types: {} }
  const activeSlot = paramStore[activeTabId]
  const slot = activeSlot && activeSlot.owner === paramOwner ? activeSlot : emptySlot
  const paramValues = slot.values

  // owner가 바뀌면(다른 저장쿼리/스크래치가 이 슬롯을 차지) 그 owner의 저장값으로 재로딩
  useEffect(() => {
    const cur = storeRef.current[activeTabId]
    if (cur && cur.owner === paramOwner) return
    let values: Record<string, ParamValue> = {}
    let types: Record<string, ParamType> = {}
    if (savedQueryId) {
      try {
        const raw = localStorage.getItem('param:' + savedQueryId)
        if (raw) {
          const p = JSON.parse(raw)
          values = p.values ?? {}
          types = p.types ?? {}
        }
      } catch {
        /* ignore */
      }
    }
    writeStore({ ...storeRef.current, [activeTabId]: { owner: paramOwner, values, types } })
  }, [activeTabId, savedQueryId, paramOwner])

  const persist = (next: ParamSlot): void => {
    if (savedQueryId) {
      try {
        localStorage.setItem(
          'param:' + savedQueryId,
          JSON.stringify({ values: next.values, types: next.types })
        )
      } catch {
        /* ignore */
      }
    }
  }
  const curSlot = (): ParamSlot => {
    const cur = storeRef.current[activeTabId]
    return cur && cur.owner === paramOwner ? cur : { owner: paramOwner, values: {}, types: {} }
  }
  const setParam = (key: string, value: ParamValue): void => {
    const base = curSlot()
    const next: ParamSlot = { ...base, values: { ...base.values, [key]: value } }
    writeStore({ ...storeRef.current, [activeTabId]: next })
    persist(next)
  }
  const setType = (key: string, type: ParamType): void => {
    const base = curSlot()
    const prevType = base.types[key] ?? paramDefs.find((d) => d.key === key)?.kind ?? 'raw'
    // multi ↔ 다른 타입 전환은 값 형상이 달라 값을 리셋
    const values =
      (prevType === 'multi') !== (type === 'multi')
        ? { ...base.values, [key]: type === 'multi' ? [] : '' }
        : base.values
    const next: ParamSlot = { owner: paramOwner, values, types: { ...base.types, [key]: type } }
    writeStore({ ...storeRef.current, [activeTabId]: next })
    persist(next)
  }

  // 위젯에서 선택된 유효 타입을 반영한 defs/kinds(range는 네이밍으로 고정 — 드롭다운 없음)
  const effectiveDefs = useMemo(
    () =>
      paramDefs.map((d) =>
        d.kind === 'range' ? d : { ...d, kind: slot.types[d.key] ?? d.kind }
      ),
    [paramDefs, slot.types]
  )
  const paramKinds = useMemo(
    () => Object.fromEntries(effectiveDefs.map((d) => [d.key, d.kind])) as KindMap,
    [effectiveDefs]
  )
  const compiledPreview = useMemo(
    () => (paramDefs.length ? applyParams(runTarget.text, paramValues, paramKinds) : runTarget.text),
    [paramDefs.length, runTarget.text, paramValues, paramKinds]
  )

  // 빈 필수 필드는 실행이 한 번 차단된 뒤에만 빨강으로(공격적 pristine 빨강 방지)
  const [paramErrors, setParamErrors] = useState(false)
  useEffect(() => setParamErrors(false), [runTarget.text, activeTabId])

  const handleRun = (): void => {
    if (running || !hostId) return
    const view = cmRef.current?.view
    const doc = view ? view.state.doc.toString() : sqlText
    const from = view ? view.state.selection.main.from : 0
    const to = view ? view.state.selection.main.to : 0
    const head = view ? view.state.selection.main.head : 0
    const target = resolveRunTarget(doc, from, to, head)
    if (target.spansMultiple || !target.text.trim()) return
    const rawDefs = scanParams(target.text)
    if (rawDefs.length) {
      const s = curSlot()
      const defs = rawDefs.map((d) =>
        d.kind === 'range' ? d : { ...d, kind: s.types[d.key] ?? d.kind }
      )
      const kinds = Object.fromEntries(defs.map((d) => [d.key, d.kind])) as KindMap
      if (!paramsReady(defs, s.values)) {
        setParamErrors(true)
        onNotify?.('매개변수 값을 먼저 채우세요')
        requestAnimationFrame(() => {
          editorPaneRef.current
            ?.querySelector<HTMLElement>(
              '.param-field.invalid input, .param-field.invalid .param-chip-input'
            )
            ?.focus()
        })
        return
      }
      onRun(applyParams(target.text, s.values, kinds))
      return
    }
    onRun(target.text)
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

  return (
    <div
      className={'editor-pane' + (split ? ' compact' : '')}
      onKeyDown={handleKeyDown}
      ref={editorPaneRef}
    >
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
          style={envSignal ? { borderLeft: '2px solid ' + envSignal } : undefined}
        >
          <option value="" disabled>
            연결 선택…
          </option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name + (h.env ? ` [${h.env}]` : '') + ' — ' + h.url}
            </option>
          ))}
        </select>
        <EnvBadge env={currentHost?.env} />

        {scanRisk && (
          <span
            className="scan-warn"
            role="note"
            title={SCAN_WARN_COPY[scanRisk]}
            aria-label={SCAN_WARN_COPY[scanRisk]}
          >
            <IconAlertTriangle size={13} />
            <span className="btn-label">LIMIT 없음</span>
          </span>
        )}

        <span className="spacer" />

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
            disabled={!hostId || runTarget.spansMultiple}
            title={runTitle}
            aria-label={runTitle}
          >
            <IconPlay size={13} />
            <span className="btn-label">실행</span>
          </button>
        )}
      </div>

      <div
        className="cm-host"
        style={envSignal ? { border: '2px solid ' + envSignal } : undefined}
      >
        <CodeMirror
          ref={cmRef}
          value={sqlText}
          theme="dark"
          extensions={[
            trinoSupport,
            cmTheme,
            activeStatement,
            paramHighlight,
            runTargetListener,
            autocompletion({ activateOnTyping: true, selectOnOpen: false })
          ]}
          onChange={onChange}
        />
      </div>

      {paramDefs.length > 0 && (
        <ParamBar
          defs={effectiveDefs}
          values={paramValues}
          onChange={setParam}
          onChangeType={setType}
          disabled={running}
          showErrors={paramErrors}
          previewSql={compiledPreview}
        />
      )}
    </div>
  )
}
