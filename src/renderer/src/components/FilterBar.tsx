import { type KeyboardEvent, useMemo } from 'react'
import {
  FILTER_OPS,
  buildPredicate,
  type FilterOp,
  type PreviewFilter
} from '../lib/previewQuery'
import { IconX } from './icons'

interface Col {
  name: string
  type: string
}

interface Props {
  columns: Col[]
  filters: PreviewFilter[]
  /** 마지막 조회에 실제 적용된 필터 스냅샷(행별 적용됨/대기 판정) */
  appliedFilters: PreviewFilter[]
  onChange: (filters: PreviewFilter[]) => void
  /** 값칸 Enter / "대기" 칩 클릭 = 조회(재조회) */
  onApply: () => void
  disabled: boolean
}

type RowState = 'applied' | 'staged' | 'empty' | 'off'

/**
 * 테이블 프리뷰 필터 바(#54) — `[체크박스] 컬럼 | 조건 | 값 | 상태칩 | −`(AND).
 * 행 추가는 그리드 컬럼 우클릭 "필터 추가"/"이 값으로 필터"로만(위쪽에 prepend). 여기엔 추가 버튼 없음.
 * 값 편집·체크·삭제는 렌더러 state만(서버 0). 재조회는 "조회"(Enter/대기칩) 명시 액션만.
 */
export function FilterBar({
  columns,
  filters,
  appliedFilters,
  onChange,
  onApply,
  disabled
}: Props): JSX.Element | null {
  const colType = (name: string): string => columns.find((c) => c.name === name)?.type ?? ''
  const appliedPreds = useMemo(
    () => new Set(appliedFilters.map(buildPredicate).filter((p): p is string => p !== null)),
    [appliedFilters]
  )
  const rowState = (f: PreviewFilter): RowState => {
    if (f.enabled === false) return 'off'
    const pred = buildPredicate(f)
    if (pred === null) return 'empty'
    return appliedPreds.has(pred) ? 'applied' : 'staged'
  }

  const update = (i: number, patch: Partial<PreviewFilter>): void =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const removeAt = (i: number): void => onChange(filters.filter((_, j) => j !== i))

  const onValueKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onApply()
    }
  }

  if (filters.length === 0) return null

  return (
    <div className="filter-bar" role="group" aria-label="필터">
      {filters.map((f, i) => {
        const st = rowState(f)
        return (
          <div
            className={'filter-row st-' + st}
            role="group"
            aria-label={`필터 ${i + 1}`}
            key={f.id ?? i}
          >
            <input
              type="checkbox"
              className="filter-on"
              checked={f.enabled !== false}
              disabled={disabled}
              aria-label={`필터 ${i + 1} 사용`}
              title="이 조건 사용/제외"
              onChange={(e) => update(i, { enabled: e.target.checked })}
            />
            <select
              className="filter-col"
              value={f.column}
              disabled={disabled}
              aria-label="컬럼"
              title={f.column}
              onChange={(e) => update(i, { column: e.target.value, colType: colType(e.target.value) })}
            >
              {!columns.some((c) => c.name === f.column) && f.column && (
                <option value={f.column}>{f.column}</option>
              )}
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="filter-op"
              value={f.op}
              disabled={disabled}
              aria-label="조건"
              title={FILTER_OPS.find((o) => o.op === f.op)?.label}
              onChange={(e) => update(i, { op: e.target.value as FilterOp })}
            >
              {FILTER_OPS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              className="filter-val"
              type="text"
              value={f.value}
              disabled={disabled}
              placeholder="값"
              aria-label="값"
              onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={onValueKey}
            />
            <span className={'filter-chip chip-' + st}>
              {st === 'applied' && <>✓ 적용됨</>}
              {st === 'staged' && (
                <button
                  type="button"
                  className="chip-apply"
                  disabled={disabled}
                  title="이 필터를 적용해 다시 조회 (⌘↵) · 서버 조회 1회"
                  onClick={onApply}
                >
                  ● 대기
                </button>
              )}
              {st === 'empty' && <span className="chip-hint">값 입력</span>}
              {st === 'off' && <>꺼짐</>}
            </span>
            <button
              className="filter-x"
              disabled={disabled}
              aria-label={`필터 ${i + 1} 제거`}
              title="이 조건 제거"
              onClick={() => removeAt(i)}
            >
              <IconX size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
