import { useEffect, useMemo, useRef, useState } from 'react'
import type { RecordSnapshot } from '../lib/cellFormat'
import { typeClass, isNullish, prettyValue } from '../lib/cellFormat'
import { IconCopy, IconInfo, IconSearch, IconSparkles, IconX } from './icons'

const api = window.api

export type InspectorTab = 'details' | 'assistant'

interface Props {
  tab: InspectorTab
  onTab: (tab: InspectorTab) => void
  /** 사이드바 닫기(툴바 토글과 별개로 패널 안에서도 닫기) */
  onClose: () => void
  /** 포커스 pane 활성 탭의 선택 행 스냅샷(없으면 null) */
  record: RecordSnapshot | null
  /** 포커스 탭에 결과가 있는지(빈 상태 카피 분기) */
  hasResult: boolean
  /** 결과에 행이 1개 이상 있는지(0행이면 클릭할 셀이 없음) */
  hasRows: boolean
  running: boolean
  hasError: boolean
}

/** 우측 인스펙터 패널 — Details(레코드 상세) / Assistant(준비중). 순수 렌더러(서버 왕복 0). */
export function InspectorPanel({
  tab,
  onTab,
  onClose,
  record,
  hasResult,
  hasRows,
  running,
  hasError
}: Props): JSX.Element {
  return (
    <aside className="inspector" role="complementary" aria-label="인스펙터">
      <div className="results-tabs insp-tabs">
        <div className="insp-tablist" role="tablist" aria-label="인스펙터">
          <button
            id="insp-tab-details"
            className={'results-tab' + (tab === 'details' ? ' active' : '')}
            role="tab"
            aria-selected={tab === 'details'}
            aria-controls="insp-panel"
            onClick={() => onTab('details')}
          >
            <IconInfo size={13} />
            Details
          </button>
          <button
            id="insp-tab-assistant"
            className={'results-tab' + (tab === 'assistant' ? ' active' : '')}
            role="tab"
            aria-selected={tab === 'assistant'}
            aria-controls="insp-panel"
            onClick={() => onTab('assistant')}
          >
            <IconSparkles size={13} />
            Assistant
          </button>
        </div>
        <span className="insp-tabs-spacer" />
        <button className="insp-close" title="사이드바 닫기 (⌘⌥B)" aria-label="사이드바 닫기" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>
      <div
        className="insp-panel"
        id="insp-panel"
        role="tabpanel"
        aria-labelledby={tab === 'details' ? 'insp-tab-details' : 'insp-tab-assistant'}
      >
        {tab === 'details' ? (
          <DetailsTab
            record={record}
            hasResult={hasResult}
            hasRows={hasRows}
            running={running}
            hasError={hasError}
          />
        ) : (
          <AssistantTab />
        )}
      </div>
    </aside>
  )
}

interface DetailsProps {
  record: RecordSnapshot | null
  hasResult: boolean
  hasRows: boolean
  running: boolean
  hasError: boolean
}

function DetailsTab({ record, hasResult, hasRows, running, hasError }: DetailsProps): JSX.Element {
  const [find, setFind] = useState('')
  const [flash, setFlash] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 새 레코드가 오면 검색 초기화
  useEffect(() => setFind(''), [record])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 1300)
    return () => clearTimeout(t)
  }, [flash])

  const q = find.trim().toLowerCase()
  const fields = useMemo(() => {
    if (!record) return []
    if (!q) return record.fields.map((f, i) => ({ ...f, idx: i }))
    return record.fields
      .map((f, i) => ({ ...f, idx: i }))
      .filter((f) => f.name.toLowerCase().includes(q))
  }, [record, q])

  // 클릭한 필드로 스크롤인
  useEffect(() => {
    if (!record || record.hitField < 0 || q) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-field="${record.hitField}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [record, q])

  const copyValue = async (v: unknown): Promise<void> => {
    await api.copyToClipboard(isNullish(v) ? '' : prettyValue(v))
    setFlash(true)
  }

  // 빈 상태
  if (!record) {
    let msg: string
    if (running) msg = '쿼리 실행 중…'
    else if (hasError) msg = '이 탭은 오류로 끝나 표시할 행이 없습니다. Messages 탭에서 원인을 확인하세요.'
    else if (!hasResult) msg = '쿼리를 실행하고 행을 선택하면 여기에 표시됩니다.'
    else if (!hasRows) msg = '결과에 행이 없습니다.'
    else msg = '그리드에서 셀을 클릭하면 그 행의 모든 필드가 여기에 펼쳐집니다.'
    return (
      <div className="insp-body">
        <div className="insp-empty">{msg}</div>
      </div>
    )
  }

  return (
    <div className="insp-body">
      {flash && <div className="copy-flash insp-flash">✓ 값 복사됨</div>}
      <div className="insp-find">
        <IconSearch size={13} />
        <input
          type="text"
          value={find}
          placeholder="필드 찾기"
          aria-label="필드 찾기"
          onChange={(e) => setFind(e.target.value)}
        />
      </div>
      <div className="insp-fields" ref={listRef}>
        {fields.length === 0 ? (
          <div className="insp-empty">일치하는 필드가 없습니다.</div>
        ) : (
          fields.map((f) => {
            const nul = isNullish(f.value)
            return (
              <div
                key={f.idx}
                data-field={f.idx}
                className={'insp-field' + (f.idx === record.hitField ? ' hit' : '')}
              >
                <div className="insp-field-head">
                  <span className="insp-field-name" title={f.name}>
                    {f.name}
                  </span>
                  <span className={'colm-type ' + typeClass(f.type)} title={f.type}>
                    {f.type}
                  </span>
                  <button
                    className="insp-copy"
                    title="값 복사"
                    aria-label="값 복사"
                    onClick={() => void copyValue(f.value)}
                  >
                    <IconCopy size={13} />
                  </button>
                </div>
                {nul ? (
                  <div className="insp-value null">NULL</div>
                ) : (
                  <div className="insp-value">{prettyValue(f.value)}</div>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="insp-footer">
        행 #{record.rowIndex + 1} · 받은 {record.rowCount.toLocaleString()}행
      </div>
    </div>
  )
}

function AssistantTab(): JSX.Element {
  return (
    <div className="insp-body">
      <div className="insp-empty">
        Assistant는 준비 중입니다.
        <br />곧 이 자리에서 결과에 대해 물어볼 수 있어요.
      </div>
    </div>
  )
}
