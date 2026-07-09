import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  QueryColumn,
  QueryErrorInfo,
  QueryResultPayload,
  QueryStatsSummary
} from '@shared/types'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconColumns,
  IconCode,
  IconCopy,
  IconDownload,
  IconEyeOff,
  IconSearch,
  IconStop
} from './icons'
import {
  typeClass,
  formatCell,
  buildRecordSnapshot,
  type RecordSnapshot
} from '../lib/cellFormat'

const api = window.api

interface Props {
  result: QueryResultPayload | null
  error: string | null
  errorInfo: QueryErrorInfo | null
  running: boolean
  progress: QueryStatsSummary | null
  onCancel: () => void
  /** 선택 셀이 속한 행 스냅샷을 인스펙터로 emit(선택 없으면 null). 내부 선택모델은 불변. */
  onSelectRecord?: (snap: RecordSnapshot | null) => void
}

const HEAD_H = 42
const ROW_H = 30
const CHAR_W = 7.3
const ROWNUM_W = 66
// 컬럼 찾기 가로 스크롤 지속시간(ms). 값을 키우면 느리게, 0이면 즉시 점프.
const SCROLL_MS = 160
const MIN_COL = 84
const MAX_COL = 460

interface ColConfig {
  origIndex: number
  width: number
  visible: boolean
}
interface SortState {
  origIndex: number
  dir: 'asc' | 'desc'
}
interface CellSel {
  row: number // displayRows 기준 인덱스
  origIndex: number
}
type CtxMenu = { x: number; y: number } & (
  | { kind: 'header'; origIndex: number }
  | { kind: 'cell'; row: number; origIndex: number }
)

/** 복사/내보내기용(NULL은 빈 문자열) */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function formatBytes(n?: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/** ms → 사람이 읽는 시간(ms / s / m s) */
function formatDuration(ms?: number): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(2)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

function signatureOf(columns: QueryColumn[]): string {
  return JSON.stringify(columns.map((c) => [c.name, c.type]))
}
function buildDefaultCols(result: QueryResultPayload): ColConfig[] {
  const sample = result.rows.slice(0, 300)
  return result.columns.map((c, ci) => {
    let max = Math.max(c.name.length, c.type.length + 2)
    for (const r of sample) {
      const v = r[ci]
      const len = v === null ? 4 : typeof v === 'object' ? JSON.stringify(v).length : String(v).length
      if (len > max) max = len
    }
    const width = Math.min(MAX_COL, Math.max(MIN_COL, Math.round(max * CHAR_W) + 26))
    return { origIndex: ci, width, visible: true }
  })
}

export function ResultsPane({
  result,
  error,
  errorInfo,
  running,
  progress,
  onCancel,
  onSelectRecord
}: Props): JSX.Element {
  const [tab, setTab] = useState<'results' | 'messages'>('results')
  const parentRef = useRef<HTMLDivElement>(null)

  // 실행 중 라이브 경과 타이머(월클럭). 실행이 시작되면 0부터 카운트업.
  const [elapsed, setElapsed] = useState(0)
  const runStartRef = useRef(0)
  useEffect(() => {
    if (!running) return
    runStartRef.current = Date.now()
    setElapsed(0)
    const iv = setInterval(() => setElapsed(Date.now() - runStartRef.current), 100)
    return () => clearInterval(iv)
  }, [running])

  const [colState, setColState] = useState<{ sig: string; cols: ColConfig[] }>({ sig: '', cols: [] })
  const [menuOpen, setMenuOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [sqlOpen, setSqlOpen] = useState(false)
  const sqlWrapRef = useRef<HTMLDivElement>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [stagesOpen, setStagesOpen] = useState(false)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [sel, setSel] = useState<CellSel | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // 컬럼 찾기: 이름 부분일치로 매칭 → 해당 컬럼으로 가로 스크롤(여러 개면 순회)
  const [find, setFind] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const findRef = useRef<HTMLInputElement>(null)
  const scrollAnimRef = useRef<number | null>(null)
  const dragColRef = useRef<number | null>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const exportWrapRef = useRef<HTMLDivElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) setTab('messages')
    else if (result) setTab('results')
  }, [result, error])

  useEffect(() => {
    if (scrollAnimRef.current != null) cancelAnimationFrame(scrollAnimRef.current)
    parentRef.current?.scrollTo(0, 0)
  }, [result])

  // 언마운트 시 진행 중 스크롤 애니메이션 정리
  useEffect(
    () => () => {
      if (scrollAnimRef.current != null) cancelAnimationFrame(scrollAnimRef.current)
    },
    []
  )

  // 복사됨 토스트 자동 소멸
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1300)
    return () => clearTimeout(t)
  }, [flash])

  // 팝오버 바깥 클릭 닫기(열 메뉴 / 내보내기 메뉴)
  useEffect(() => {
    if (!menuOpen && !exportOpen && !sqlOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuOpen && !menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
      if (exportOpen && !exportWrapRef.current?.contains(e.target as Node)) setExportOpen(false)
      if (sqlOpen && !sqlWrapRef.current?.contains(e.target as Node)) setSqlOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen, exportOpen, sqlOpen])

  // 컨텍스트 메뉴: 바깥 클릭·Esc·스크롤 시 닫기
  useEffect(() => {
    if (!ctxMenu) return
    const close = (): void => setCtxMenu(null)
    const onDoc = (e: MouseEvent): void => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  // result에 memoize: result가 null일 때 매 렌더 새 [] 를 만들지 않도록(참조 안정) —
  // 안 그러면 displayRows/emit effect가 매 렌더 발화해 무한 렌더 루프에 빠진다.
  const columns = useMemo(() => result?.columns ?? [], [result])
  const rows = useMemo(() => result?.rows ?? [], [result])

  // 새 쿼리 모양(시그니처 변경)이면 컬럼/정렬/선택 초기화
  const currentSig = result ? signatureOf(columns) : ''
  let cols: ColConfig[]
  if (result && currentSig !== colState.sig) {
    cols = buildDefaultCols(result)
    setColState({ sig: currentSig, cols })
    setSort(null)
    setSel(null)
    setFind('')
    setMatchIdx(0)
  } else {
    cols = colState.cols
  }

  const updateCols = (fn: (c: ColConfig[]) => ColConfig[]): void =>
    setColState((s) => ({ sig: s.sig, cols: fn(s.cols) }))
  const visibleCols = cols.filter((c) => c.visible)

  // ----- 컬럼 찾기: 보이는 컬럼 이름 부분일치(대소문자 무시) -----
  const findQ = find.trim().toLowerCase()
  const matches = findQ
    ? visibleCols
        .map((c) => c.origIndex)
        .filter((oi) => columns[oi].name.toLowerCase().includes(findQ))
    : []
  const curMatch = matches.length ? Math.min(matchIdx, matches.length - 1) : 0
  const hitOrigIndex = matches.length ? matches[curMatch] : null
  // 네이티브 smooth는 속도가 브라우저 고정이라, 지정 지속시간·이징으로 직접 애니메이션
  const scrollLeftTo = (el: HTMLElement, to: number, ms: number): void => {
    if (scrollAnimRef.current != null) cancelAnimationFrame(scrollAnimRef.current)
    const from = el.scrollLeft
    const dist = to - from
    if (ms <= 0 || Math.abs(dist) < 1) {
      el.scrollLeft = to
      return
    }
    const start = performance.now()
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3) // easeOutCubic
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms)
      el.scrollLeft = from + dist * ease(t)
      scrollAnimRef.current = t < 1 ? requestAnimationFrame(step) : null
    }
    scrollAnimRef.current = requestAnimationFrame(step)
  }
  const scrollToCol = (origIndex: number): void => {
    const wrap = parentRef.current
    const cell = wrap?.querySelector(`.g-hcell[data-col="${origIndex}"]`)
    if (!(cell instanceof HTMLElement) || !wrap) return
    // 컬럼 중앙이 뷰포트 중앙에 오도록 스크롤. 단 스크롤 범위를 벗어나면 클램프해서
    // 앞쪽 컬럼(중앙 두면 왼쪽 여백)은 0=왼쪽 그대로, 뒤쪽 컬럼은 max=오른쪽 그대로 둔다.
    const center = cell.offsetLeft + cell.offsetWidth / 2 - wrap.clientWidth / 2
    const max = wrap.scrollWidth - wrap.clientWidth
    scrollLeftTo(wrap, Math.max(0, Math.min(center, max)), SCROLL_MS)
  }
  const goMatch = (delta: number): void => {
    if (!matches.length) return
    setMatchIdx((curMatch + delta + matches.length) % matches.length)
  }
  // 현재 매칭이 바뀌면(타이핑/순회) 그 컬럼으로 스크롤
  useEffect(() => {
    if (hitOrigIndex != null) scrollToCol(hitOrigIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitOrigIndex])

  // ----- 클라이언트 정렬(현재 페이지 한정, 타입 인지) -----
  const displayRows = useMemo(() => {
    if (!sort) return rows
    const { origIndex, dir } = sort
    const numeric = typeClass(columns[origIndex]?.type ?? '') === 't-num'
    const sign = dir === 'asc' ? 1 : -1
    return rows
      .map((r, i) => [r, i] as const)
      .sort(([a], [b]) => {
        const av = a[origIndex]
        const bv = b[origIndex]
        if (av == null && bv == null) return 0
        if (av == null) return 1 // NULL은 항상 끝
        if (bv == null) return -1
        let c: number
        if (numeric) c = Number(av) - Number(bv)
        else {
          const as = String(av)
          const bs = String(bv)
          c = as < bs ? -1 : as > bs ? 1 : 0
        }
        return c * sign
      })
      .map(([r]) => r)
  }, [rows, sort, columns])

  const toggleSort = (origIndex: number): void => {
    setSel(null)
    setSort((s) => {
      if (!s || s.origIndex !== origIndex) return { origIndex, dir: 'asc' }
      if (s.dir === 'asc') return { origIndex, dir: 'desc' }
      return null // desc → 정렬 해제(원본 순서)
    })
  }

  // ----- 리사이즈 -----
  const onResizeStart = (e: React.MouseEvent, origIndex: number, startW: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const move = (ev: MouseEvent): void => {
      const w = Math.max(MIN_COL, startW + (ev.clientX - startX))
      updateCols((cs) => cs.map((c) => (c.origIndex === origIndex ? { ...c, width: w } : c)))
    }
    const end = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    document.body.classList.add('col-resizing')
  }

  // ----- 순서 변경(드래그) -----
  const handleDrop = (targetOrigIndex: number): void => {
    const from = dragColRef.current
    dragColRef.current = null
    setDropTarget(null)
    if (from == null || from === targetOrigIndex) return
    updateCols((cs) => {
      const arr = [...cs]
      const fi = arr.findIndex((c) => c.origIndex === from)
      const ti = arr.findIndex((c) => c.origIndex === targetOrigIndex)
      if (fi < 0 || ti < 0) return cs
      const [moved] = arr.splice(fi, 1)
      arr.splice(ti, 0, moved)
      return arr
    })
  }

  // ----- 숨김/표시 -----
  const toggleVisible = (origIndex: number): void =>
    updateCols((cs) => cs.map((c) => (c.origIndex === origIndex ? { ...c, visible: !c.visible } : c)))
  const resetCols = (): void => {
    if (result) setColState({ sig: currentSig, cols: buildDefaultCols(result) })
  }

  // ----- 복사 / 내보내기 -----
  const flashCopy = async (text: string, label: string): Promise<void> => {
    await api.copyToClipboard(text)
    setFlash(label)
  }
  const copyCell = (row: number, origIndex: number): void => {
    void flashCopy(cellText(displayRows[row]?.[origIndex]), '셀 복사됨')
  }
  const copyRow = (row: number): void => {
    const r = displayRows[row]
    if (!r) return
    void flashCopy(visibleCols.map((c) => cellText(r[c.origIndex])).join('\t'), '행 복사됨')
  }
  const copyColumn = (origIndex: number): void => {
    void flashCopy(displayRows.map((r) => cellText(r[origIndex])).join('\n'), '열 복사됨')
  }
  const buildTsv = (): string => {
    const head = visibleCols.map((c) => columns[c.origIndex].name).join('\t')
    const body = displayRows.map((r) => visibleCols.map((c) => cellText(r[c.origIndex])).join('\t'))
    return [head, ...body].join('\n')
  }
  const copyAll = (): void => void flashCopy(buildTsv(), `${displayRows.length.toLocaleString()}행 복사됨`)

  const doExport = async (kind: 'csv' | 'json'): Promise<void> => {
    setExportOpen(false)
    let content: string
    if (kind === 'csv') {
      const head = visibleCols.map((c) => csvField(columns[c.origIndex].name)).join(',')
      const body = displayRows.map((r) => visibleCols.map((c) => csvField(cellText(r[c.origIndex]))).join(','))
      content = [head, ...body].join('\r\n')
    } else {
      const names = visibleCols.map((c) => columns[c.origIndex].name)
      const arr = displayRows.map((r) => {
        const o: Record<string, unknown> = {}
        visibleCols.forEach((c, i) => (o[names[i]] = r[c.origIndex] ?? null))
        return o
      })
      content = JSON.stringify(arr, null, 2)
    }
    const res = await api.saveTextFile({
      defaultName: `trino-result-${displayRows.length}rows.${kind}`,
      content
    })
    if (res.saved) setFlash('저장됨')
  }

  const selectCell = (row: number, origIndex: number): void => {
    setSel({ row, origIndex })
    parentRef.current?.focus()
  }

  // 선택(또는 정렬/새 결과로 인한 변경) 시 인스펙터로 행 스냅샷 emit-up(A2 — 내부 선택모델 불변).
  // 콜백 identity 변화로 인한 재발화를 막기 위해 ref로 최신 콜백만 참조.
  const emitRef = useRef(onSelectRecord)
  emitRef.current = onSelectRecord
  useEffect(() => {
    const emit = emitRef.current
    if (!emit) return
    if (!sel || !result) {
      emit(null)
      return
    }
    const rowVals = displayRows[sel.row]
    if (!rowVals) {
      emit(null)
      return
    }
    emit(buildRecordSnapshot(columns, rowVals, sel.origIndex, sel.row, displayRows.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, displayRows, columns, result])
  const onGridKey = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && sel) {
      e.preventDefault()
      copyCell(sel.row, sel.origIndex)
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      findRef.current?.focus()
      findRef.current?.select()
    }
  }

  const rowVirt = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
    scrollMargin: HEAD_H
  })

  const template = `${ROWNUM_W}px ${visibleCols.map((c) => `${c.width}px`).join(' ')}`
  const totalWidth = ROWNUM_W + visibleCols.reduce((a, c) => a + c.width, 0)
  const baseIndex = 0 // 전체 결과가 메모리에 있으므로 행번호는 항상 1..N
  const stats = result?.stats
  const cancelled = result?.cancelled ?? false
  // 중지되었거나 FINISHED가 아니면 통계가 미확정(잠정) — 배너 + 값 흐리게로 신호.
  // (중지 시 stats가 아예 없을 수 있어 cancelled를 먼저 반영해야 '확정'으로 오표기되지 않음)
  const finished = !cancelled && (!stats || stats.state === 'FINISHED')
  const num = (n?: number): string | null => (n == null ? null : n.toLocaleString())
  const statGroups: { title: string; items: [string, string][] }[] = stats
    ? [
        {
          title: '시간',
          items: [
            ['CPU 시간', stats.cpuTimeMillis != null ? formatDuration(stats.cpuTimeMillis) : null],
            ['대기 시간', stats.queuedTimeMillis != null ? formatDuration(stats.queuedTimeMillis) : null],
            ['Wall 시간', stats.wallTimeMillis != null ? formatDuration(stats.wallTimeMillis) : null]
          ]
        },
        {
          title: '입출력(I/O)',
          items: [
            ['처리 행', num(stats.processedRows)],
            ['처리 바이트', stats.processedBytes != null ? formatBytes(stats.processedBytes) : null],
            ['물리 읽기', stats.physicalInputBytes != null ? formatBytes(stats.physicalInputBytes) : null],
            ['스필(디스크)', stats.spilledBytes ? formatBytes(stats.spilledBytes) : null]
          ]
        },
        {
          title: '메모리',
          items: [
            ['피크 메모리', stats.peakMemoryBytes != null ? formatBytes(stats.peakMemoryBytes) : null]
          ]
        },
        {
          title: '병렬성',
          items: [
            ['워커 노드', num(stats.nodes)],
            ['스플릿 전체', num(stats.totalSplits)],
            ['스플릿 완료', num(stats.completedSplits)],
            ['스플릿 실행중', num(stats.runningSplits)],
            ['스플릿 대기', num(stats.queuedSplits)]
          ]
        }
      ]
        .map((g) => ({
          title: g.title,
          items: g.items.filter((it): it is [string, string] => it[1] != null)
        }))
        .filter((g) => g.items.length > 0)
    : []

  return (
    <section className="results">
      <div className="results-tabs">
        <button
          className={'results-tab' + (tab === 'results' ? ' active' : '')}
          onClick={() => setTab('results')}
        >
          Results
          {result && <span className="badge">{result.rowCount.toLocaleString()}</span>}
        </button>
        <button
          className={'results-tab' + (tab === 'messages' ? ' active' : '')}
          onClick={() => setTab('messages')}
        >
          Messages
          {error && <span className="badge err">●</span>}
        </button>

        {result && tab === 'results' && (
          <>
            <div className="col-find">
              <IconSearch size={13} />
              <input
                ref={findRef}
                className={'col-find-input' + (findQ && !matches.length ? ' no-match' : '')}
                value={find}
                placeholder="컬럼 찾기"
                title="컬럼 이름으로 찾아 이동 (⌘F · Enter=다음 / ⇧Enter=이전)"
                onChange={(e) => {
                  setFind(e.target.value)
                  setMatchIdx(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    goMatch(e.shiftKey ? -1 : 1)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setFind('')
                    e.currentTarget.blur()
                  }
                }}
              />
              {findQ && (
                <>
                  <span className="col-find-count">
                    {matches.length ? `${curMatch + 1}/${matches.length}` : '없음'}
                  </span>
                  <button
                    className="col-find-nav"
                    title="이전 (⇧Enter)"
                    disabled={matches.length < 2}
                    onClick={() => goMatch(-1)}
                  >
                    <IconChevronLeft size={14} />
                  </button>
                  <button
                    className="col-find-nav"
                    title="다음 (Enter)"
                    disabled={matches.length < 2}
                    onClick={() => goMatch(1)}
                  >
                    <IconChevronRight size={14} />
                  </button>
                </>
              )}
            </div>
            {flash && <span className="copy-flash">✓ {flash}</span>}
            <span className="spacer" />
            <button className="cols-btn" onClick={copyAll} title="전체를 TSV로 클립보드 복사">
              <IconCopy size={14} />복사
            </button>
            <div className="cols-menu-wrap" ref={exportWrapRef}>
              <button className="cols-btn" onClick={() => setExportOpen((o) => !o)} title="파일로 내보내기">
                <IconDownload size={14} />내보내기
              </button>
              {exportOpen && (
                <div className="cols-menu export-menu">
                  <ul>
                    <li>
                      <button className="menu-row" onClick={() => void doExport('csv')}>
                        CSV로 저장
                      </button>
                    </li>
                    <li>
                      <button className="menu-row" onClick={() => void doExport('json')}>
                        JSON으로 저장
                      </button>
                    </li>
                  </ul>
                </div>
              )}
            </div>
            <div className="cols-menu-wrap" ref={menuWrapRef}>
              <button className="cols-btn" onClick={() => setMenuOpen((o) => !o)} title="열 표시/순서">
                <IconColumns size={14} />열
              </button>
              {menuOpen && (
                <div className="cols-menu">
                  <div className="cols-menu-head">
                    <span>
                      열 {visibleCols.length}/{cols.length}
                    </span>
                    <button className="ghost" onClick={resetCols}>
                      초기화
                    </button>
                  </div>
                  <ul>
                    {cols.map((c) => {
                      const col = columns[c.origIndex]
                      const lastVisible = c.visible && visibleCols.length === 1
                      return (
                        <li key={c.origIndex}>
                          <label>
                            <input
                              type="checkbox"
                              checked={c.visible}
                              disabled={lastVisible}
                              onChange={() => toggleVisible(c.origIndex)}
                            />
                            <span className="colm-name">{col.name}</span>
                            <span className={'colm-type ' + typeClass(col.type)}>{col.type}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="results-body">
        {running ? (
          <div className="results-status">
            <div className="run-overlay">
              <span className="spin" />
              <div className="run-info">
                <div className="run-elapsed">{(elapsed / 1000).toFixed(1)}s</div>
                <div className="run-meta">
                  {progress?.state ?? '실행 준비 중'}
                  {progress?.processedRows != null &&
                    ` · ${progress.processedRows.toLocaleString()} rows 스캔`}
                  {progress?.processedBytes != null && ` · ${formatBytes(progress.processedBytes)}`}
                </div>
              </div>
              <button className="danger" onClick={onCancel} title="실행 중지">
                <IconStop size={13} />
                중지
              </button>
            </div>
          </div>
        ) : tab === 'messages' ? (
          error ? (
            <div className="messages error-card">
              <div className="err-head">
                <span className="err-name">{errorInfo?.errorName ?? '쿼리 실패'}</span>
                {errorInfo?.errorType && <span className="err-type">{errorInfo.errorType}</span>}
                {errorInfo?.line != null && (
                  <span className="err-loc">
                    line {errorInfo.line}
                    {errorInfo.column != null ? `:${errorInfo.column}` : ''}
                  </span>
                )}
              </div>
              <pre className="err-msg">{error}</pre>
            </div>
          ) : result ? (
            <div className="messages">
              {/* 상태 줄: 확정/잠정 배지 + queryId */}
              <div className="msg-status">
                <span className={'msg-badge ' + (finished ? 'ok' : 'warn')}>
                  <span className="msg-badge-dot" />
                  {cancelled ? '중지됨' : finished ? '확정' : '잠정'} ·{' '}
                  {cancelled ? 'CANCELED' : (stats?.state ?? 'FINISHED')}
                </span>
                {result.queryId && (
                  <button
                    className="qid-chip"
                    title={result.queryId}
                    onClick={() => void flashCopy(result.queryId as string, 'Query ID 복사됨')}
                  >
                    id {result.queryId}
                  </button>
                )}
              </div>

              {cancelled && (
                <div className="warn-banner">
                  ⏹ 실행을 중지했습니다. 아래 통계·결과는 중지 시점까지 받은 부분값이며, 통계는
                  하한입니다.
                </div>
              )}
              {!finished && !cancelled && (
                <div className="warn-banner">
                  결과를 끝까지 받지 않아 통계가 확정되지 않았습니다 (LIMIT 도달). 아래 값은
                  하한입니다.
                </div>
              )}

              {/* 핵심 지표 */}
              <div className="msg-keyrow">
                <span>
                  <b>{result.rowCount.toLocaleString()}</b> rows
                </span>
                {stats?.elapsedMs != null && (
                  <span>
                    <b>{formatDuration(stats.elapsedMs)}</b> 경과
                  </span>
                )}
                {stats?.processedRows != null && (
                  <span>
                    스캔 <b>{stats.processedRows.toLocaleString()}</b> rows ·{' '}
                    {formatBytes(stats.processedBytes)}
                  </span>
                )}
              </div>

              {/* 경고(있을 때만) */}
              {result.warnings && result.warnings.length > 0 && (
                <div className="warn-list">
                  <div className="warn-list-head">⚠ 경고 {result.warnings.length}건</div>
                  {result.warnings.map((w, i) => (
                    <div className="warn-item" key={i}>
                      {w}
                    </div>
                  ))}
                </div>
              )}

              {/* 액션: Web UI 열기 + 상세 통계 토글 */}
              <div className="msg-actions">
                {result.infoUri && (
                  <button
                    className="cols-btn"
                    onClick={() => void api.openExternal(result.infoUri as string)}
                    title="코디네이터 Web UI · 접근 권한/보관 기간 내에서만 열림"
                  >
                    Trino Web UI에서 열기 ↗
                  </button>
                )}
                <button className="cols-btn" onClick={() => setDetailOpen((o) => !o)}>
                  {detailOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  상세 통계
                </button>
              </div>

              {/* 상세 통계(접힘) */}
              {detailOpen && (
                <div className="stat-groups">
                  {statGroups.map((g) => (
                    <div className="stat-group" key={g.title}>
                      <div className="stat-group-title">
                        {g.title}
                        {!finished && <span className="prov-tag">잠정</span>}
                      </div>
                      <div className="stat-grid">
                        {g.items.map(([label, value]) => (
                          <div className="stat-pair" key={label}>
                            <span className="stat-label">{label}</span>
                            <span
                              className={
                                'stat-value' +
                                (!finished && (label === '피크 메모리' || label.startsWith('스필'))
                                  ? ' provisional'
                                  : '')
                              }
                            >
                              {value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* 스테이지(이중 접힘) */}
                  {stats?.stages && stats.stages.length > 0 && (
                    <div className="stat-group">
                      <button className="stages-toggle" onClick={() => setStagesOpen((o) => !o)}>
                        {stagesOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                        스테이지 ({stats.stages.length})
                      </button>
                      {stagesOpen && (
                        <div className="stage-list">
                          {stats.stages.map((st, i) => (
                            <div
                              className="stage-row"
                              key={st.stageId}
                              style={{ paddingLeft: 4 + st.depth * 16 }}
                              title={st.stageId}
                            >
                              <span
                                className={'stage-dot ' + (st.state === 'FINISHED' ? 'ok' : 'run')}
                              />
                              <span className="stage-name">Stage {i}</span>
                              {st.coordinatorOnly && <span className="stage-tag">coordinator</span>}
                              <span className="stage-metrics">
                                {st.processedRows.toLocaleString()} rows · {formatBytes(st.processedBytes)}{' '}
                                · cpu {formatDuration(st.cpuTimeMillis)} · splits {st.completedSplits}/
                                {st.totalSplits}
                                {(st.runningSplits > 0 || st.queuedSplits > 0) &&
                                  ` (실행 ${st.runningSplits}·대기 ${st.queuedSplits})`}
                              </span>
                              {st.failedTasks > 0 && (
                                <span className="stage-fail">실패 {st.failedTasks}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {result.executedSql && (
                <div className="msg-sql">
                  <div className="msg-sql-head">
                    <span>서버로 보낸 SQL</span>
                    <button
                      className="cols-btn"
                      onClick={() => void flashCopy(result.executedSql, '실행 SQL 복사됨')}
                      title="실행된 SQL 복사"
                    >
                      <IconCopy size={13} />복사
                    </button>
                  </div>
                  <pre className="msg-sql-body">{result.executedSql}</pre>
                </div>
              )}
            </div>
          ) : (
            <div className="results-status">메시지가 없습니다.</div>
          )
        ) : !result ? (
          <div className="results-status">
            {error ? 'Messages 탭에서 오류를 확인하세요.' : '쿼리를 실행하면 결과가 여기에 표시됩니다.'}
          </div>
        ) : (
          <>
            {cancelled && (
              <div className="warn-banner">
                ⏹ 실행을 중지했습니다 — 아래는 중지 시점까지 받은 {result.rowCount.toLocaleString()}
                행입니다.
              </div>
            )}
            <div className="grid-wrap" ref={parentRef} tabIndex={0} onKeyDown={onGridKey}>
              <div className="grid2" style={{ width: totalWidth, minWidth: '100%' }}>
                <div className="grid2-head" style={{ gridTemplateColumns: template, height: HEAD_H }}>
                  <div className="g-hcell rownum">#</div>
                  {visibleCols.map((c) => {
                    const col = columns[c.origIndex]
                    const sorted = sort?.origIndex === c.origIndex ? sort.dir : null
                    return (
                      <div
                        className={
                          'g-hcell' +
                          (dropTarget === c.origIndex ? ' drop-target' : '') +
                          (sorted ? ' sorted' : '') +
                          (matches.includes(c.origIndex) ? ' col-match' : '') +
                          (hitOrigIndex === c.origIndex ? ' col-hit' : '')
                        }
                        key={c.origIndex}
                        data-col={c.origIndex}
                        title={`${col.name} · ${col.type} — 클릭: 정렬 / 우클릭: 메뉴`}
                        draggable
                        onClick={() => toggleSort(c.origIndex)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setCtxMenu({
                            kind: 'header',
                            origIndex: c.origIndex,
                            x: Math.min(e.clientX, window.innerWidth - 170),
                            y: Math.min(e.clientY, window.innerHeight - 60)
                          })
                        }}
                        onDragStart={() => (dragColRef.current = c.origIndex)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          if (dropTarget !== c.origIndex) setDropTarget(c.origIndex)
                        }}
                        onDragLeave={() => setDropTarget((t) => (t === c.origIndex ? null : t))}
                        onDrop={(e) => {
                          e.preventDefault()
                          handleDrop(c.origIndex)
                        }}
                        onDragEnd={() => {
                          dragColRef.current = null
                          setDropTarget(null)
                        }}
                      >
                        <span className="col-name">
                          {col.name}
                          {sorted === 'asc' && <IconArrowUp size={11} />}
                          {sorted === 'desc' && <IconArrowDown size={11} />}
                        </span>
                        <span className={'col-type ' + typeClass(col.type)}>{col.type}</span>
                        <div
                          className="col-resizer"
                          onMouseDown={(e) => onResizeStart(e, c.origIndex, c.width)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="grid2-body" style={{ height: rowVirt.getTotalSize() }}>
                  {rowVirt.getVirtualItems().map((vi) => {
                    const row = displayRows[vi.index]
                    return (
                      <div
                        className="g-row"
                        key={vi.key}
                        style={{
                          gridTemplateColumns: template,
                          height: ROW_H,
                          transform: `translateY(${vi.start - rowVirt.options.scrollMargin}px)`
                        }}
                      >
                        <div className="g-cell rownum">{(baseIndex + vi.index + 1).toLocaleString()}</div>
                        {visibleCols.map((c) => {
                          const cell = row[c.origIndex]
                          const isNum = typeClass(columns[c.origIndex].type) === 't-num'
                          const isSel = sel?.row === vi.index && sel.origIndex === c.origIndex
                          return (
                            <div
                              key={c.origIndex}
                              className={
                                'g-cell' +
                                (isNum ? ' num' : '') +
                                (cell === null ? ' null' : '') +
                                (isSel ? ' selected' : '')
                              }
                              title={cell === null ? 'NULL' : formatCell(cell)}
                              onClick={() => selectCell(vi.index, c.origIndex)}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                selectCell(vi.index, c.origIndex)
                                setCtxMenu({
                                  kind: 'cell',
                                  row: vi.index,
                                  origIndex: c.origIndex,
                                  x: Math.min(e.clientX, window.innerWidth - 170),
                                  y: Math.min(e.clientY, window.innerHeight - 130)
                                })
                              }}
                            >
                              {cell === null ? 'NULL' : formatCell(cell)}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {ctxMenu && (
        <div className="ctx-menu" ref={ctxMenuRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxMenu.kind === 'cell' ? (
            <>
              <button
                className="ctx-item"
                onClick={() => {
                  copyCell(ctxMenu.row, ctxMenu.origIndex)
                  setCtxMenu(null)
                }}
              >
                <IconCopy size={14} />값 복사
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  copyRow(ctxMenu.row)
                  setCtxMenu(null)
                }}
              >
                <IconCopy size={14} />행 복사 (TSV)
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  copyColumn(ctxMenu.origIndex)
                  setCtxMenu(null)
                }}
              >
                <IconCopy size={14} />열 복사
              </button>
            </>
          ) : (
            <button
              className="ctx-item"
              disabled={visibleCols.length === 1}
              onClick={() => {
                toggleVisible(ctxMenu.origIndex)
                setCtxMenu(null)
              }}
            >
              <IconEyeOff size={14} />열 숨김
            </button>
          )}
        </div>
      )}

      {result && !running && (
        <div className="transport">
          <span
            className={'ft-state ' + (finished ? 'ok' : 'warn')}
            title={
              cancelled
                ? '실행 중지됨 — 중지 시점까지의 부분 결과'
                : finished
                  ? '확정된 통계'
                  : '잠정(부분 통계) — 끝까지 수신 안 됨'
            }
          />
          {cancelled && (
            <span className="stat" style={{ color: 'var(--warn)' }} title="사용자가 실행을 중지했습니다">
              ⏹ 중지됨
            </span>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <span className="ft-warn" title="Trino 경고 있음(Messages 참고)">
              ⚠ {result.warnings.length}
            </span>
          )}
          <span className="stat">
            <b>{result.rowCount.toLocaleString()}</b> {result.truncated ? 'rows (상한)' : 'rows'}
          </span>
          {sort && (
            <span className="stat sort-note">
              {result.truncated || cancelled ? '받은 행만 정렬' : '정렬됨'}
            </span>
          )}
          {result.truncated && (
            <span
              className="stat"
              style={{ color: 'var(--warn)' }}
              title="5만 행 안전 상한에서 멈췄습니다 — SQL에 LIMIT을 추가하거나 WHERE로 범위를 좁혀 다시 실행하세요"
            >
              ⚠ 5만 행에서 멈춤 — LIMIT/WHERE로 좁혀 재실행
            </span>
          )}
          {stats?.elapsedMs != null && (
            <span className="stat">
              <b>{(stats.elapsedMs / 1000).toFixed(2)}s</b>
            </span>
          )}
          {stats?.processedRows != null && (
            <span className="stat">
              scan <b>{stats.processedRows.toLocaleString()}</b>
            </span>
          )}
          {stats?.processedBytes != null && (
            <span className="stat">
              <b>{formatBytes(stats.processedBytes)}</b>
            </span>
          )}
          <span className="spacer" />
          {result.executedSql && (
            <div className="sql-pop-wrap" ref={sqlWrapRef}>
              <button
                className={'sql-btn' + (sqlOpen ? ' active' : '')}
                onClick={() => setSqlOpen((o) => !o)}
                title="서버로 보낸 실제 SQL 보기"
              >
                <IconCode size={13} /> SQL
              </button>
              {sqlOpen && (
                <div className="sql-pop">
                  <div className="sql-pop-head">
                    <span>서버로 보낸 SQL</span>
                    <button
                      className="cols-btn"
                      onClick={() => void flashCopy(result.executedSql, '실행 SQL 복사됨')}
                      title="실행된 SQL 복사"
                    >
                      <IconCopy size={13} />복사
                    </button>
                  </div>
                  <pre>{result.executedSql}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
