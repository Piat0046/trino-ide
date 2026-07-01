import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { QueryColumn, QueryResultPayload } from '@shared/types'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconColumns,
  IconCopy,
  IconDownload,
  IconEyeOff
} from './icons'

const api = window.api

interface Props {
  result: QueryResultPayload | null
  error: string | null
  running: boolean
  onPrevPage: () => void
  onNextPage: () => void
}

const HEAD_H = 42
const ROW_H = 30
const CHAR_W = 7.3
const ROWNUM_W = 66
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

type TypeClass = 't-num' | 't-str' | 't-time' | 't-bool'
function typeClass(type: string): TypeClass {
  const t = type.toLowerCase()
  if (/(int|bigint|smallint|tinyint|double|real|decimal|numeric|float)/.test(t)) return 't-num'
  if (/(timestamp|date|time|interval)/.test(t)) return 't-time'
  if (/bool/.test(t)) return 't-bool'
  return 't-str'
}
/** 그리드 표시용(NULL 라벨 유지) */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
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

export function ResultsPane({ result, error, running, onPrevPage, onNextPage }: Props): JSX.Element {
  const [tab, setTab] = useState<'results' | 'messages'>('results')
  const parentRef = useRef<HTMLDivElement>(null)

  const [colState, setColState] = useState<{ sig: string; cols: ColConfig[] }>({ sig: '', cols: [] })
  const [menuOpen, setMenuOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [sel, setSel] = useState<CellSel | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const dragColRef = useRef<number | null>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const exportWrapRef = useRef<HTMLDivElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) setTab('messages')
    else if (result) setTab('results')
  }, [result, error])

  useEffect(() => {
    parentRef.current?.scrollTo(0, 0)
  }, [result])

  // 복사됨 토스트 자동 소멸
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1300)
    return () => clearTimeout(t)
  }, [flash])

  // 팝오버 바깥 클릭 닫기(열 메뉴 / 내보내기 메뉴)
  useEffect(() => {
    if (!menuOpen && !exportOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuOpen && !menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
      if (exportOpen && !exportWrapRef.current?.contains(e.target as Node)) setExportOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen, exportOpen])

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

  const columns = result?.columns ?? []
  const rows = result?.rows ?? []

  // 새 쿼리 모양(시그니처 변경)이면 컬럼/정렬/선택 초기화
  const currentSig = result ? signatureOf(columns) : ''
  let cols: ColConfig[]
  if (result && currentSig !== colState.sig) {
    cols = buildDefaultCols(result)
    setColState({ sig: currentSig, cols })
    setSort(null)
    setSel(null)
  } else {
    cols = colState.cols
  }

  const updateCols = (fn: (c: ColConfig[]) => ColConfig[]): void =>
    setColState((s) => ({ sig: s.sig, cols: fn(s.cols) }))
  const visibleCols = cols.filter((c) => c.visible)

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
  const onGridKey = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && sel) {
      e.preventDefault()
      copyCell(sel.row, sel.origIndex)
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
  const baseIndex = sort ? 0 : result?.paginated ? result.page * (result.pageSize ?? 0) : 0
  const stats = result?.stats

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
            <span className="spin" />
            실행 중…
          </div>
        ) : tab === 'messages' ? (
          error ? (
            <pre className="messages error">{error}</pre>
          ) : result ? (
            <div className="messages">
              <div className="ok-line">✓ 완료 · {stats?.state ?? 'FINISHED'}</div>
              <div>
                {result.rowCount.toLocaleString()} rows {result.paginated ? `(page ${result.page + 1})` : ''}
              </div>
              {stats?.elapsedMs != null && <div>소요 {(stats.elapsedMs / 1000).toFixed(2)}s</div>}
              {stats?.processedRows != null && (
                <div>
                  스캔 {stats.processedRows.toLocaleString()} rows · {formatBytes(stats.processedBytes)}
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
            {result.orderByWarning && (
              <div className="warn-banner">
                ⚠ ORDER BY가 없어 페이지 간 행 순서가 일정하지 않을 수 있습니다.
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
                          (sorted ? ' sorted' : '')
                        }
                        key={c.origIndex}
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
          {result.paginated && (
            <div className="pager">
              <button onClick={onPrevPage} disabled={result.page === 0} title="이전 페이지">
                <IconChevronLeft size={14} />
              </button>
              <span className="page-label">Page {result.page + 1}</span>
              <button onClick={onNextPage} disabled={!result.hasNext} title="다음 페이지">
                <IconChevronRight size={14} />
              </button>
            </div>
          )}
          <span className="stat">
            <b>{result.rowCount.toLocaleString()}</b> rows{result.paginated ? ' / page' : ''}
          </span>
          {sort && <span className="stat sort-note">현재 페이지 정렬</span>}
          {result.truncated && (
            <span className="stat" style={{ color: 'var(--warn)' }}>
              안전 상한 도달 — 더 보려면 LIMIT에 숫자를 넣어 페이지로 나눠 보세요
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
        </div>
      )}
    </section>
  )
}
