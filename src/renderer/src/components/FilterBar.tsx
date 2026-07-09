import { type KeyboardEvent, useMemo } from 'react'
import {
  FILTER_OPS,
  buildPredicate,
  type FilterOp,
  type PreviewFilter
} from '../lib/previewQuery'
import { IconPlus, IconX } from './icons'

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
 * 테이블 프리뷰 필터 바(#54) — 온디맨드 행: `[체크박스] 컬럼 | 조건 | 값 | 상태칩 | ＋ −`(AND).
 * 값 편집·체크·행 추가/삭제는 렌더러 state만(서버 0). 재조회는 "조회"(Enter/대기칩) 명시 액션만.
 * 상태칩은 마지막 실행된 필터 스냅샷에서 파생 → 거짓 "적용됨" 없음.
 */
export function FilterBar({
  columns,
  filters,
  appliedFilters,
  onChange,
  onApply,
  disabled
}: Props): JSX.Element {
  const colType = (name: string): string => columns.find((c) => c.name === name)?.type ?? ''
  // 마지막 조회에 실제 들어간 predicate 집합(행별 "적용됨" 판정)
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
  const insertAfter = (i: number): void => {
    // 같은 컬럼을 복제해 바로 아래 삽입(한 컬럼 2조건 흐름)
    const base = filters[i]
    const clone: PreviewFilter = { ...base, value: '', enabled: true }
    onChange([...filters.slice(0, i + 1), clone, ...filters.slice(i + 1)])
  }
  const add = (): void => {
    const first = columns[0]?.name ?? ''
    onChange([...filters, { column: first, op: 'eq', value: '', colType: colType(first), enabled: true }])
  }
  const onValueKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onApply()
    }
  }

  return (
    <div className="filter-bar" role="group" aria-label="필터">
      {filters.map((f, i) => {
        const st = rowState(f)
        return (
          <div className={'filter-row st-' + st} role="group" aria-label={`필터 ${i + 1}`} key={i}>
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
            <div className="filter-rowbtns">
              <button
                className="filter-x"
                disabled={disabled}
                aria-label={`필터 ${i + 1} 제거`}
                title="이 조건 제거"
                onClick={() => removeAt(i)}
              >
                <IconX size={12} />
              </button>
              <button
                className="filter-x"
                disabled={disabled}
                aria-label={`필터 ${i + 1} 아래에 추가`}
                title="아래에 조건 추가"
                onClick={() => insertAfter(i)}
              >
                <IconPlus size={12} />
              </button>
            </div>
          </div>
        )
      })}
      <button className="filter-add" disabled={disabled || columns.length === 0} onClick={add}>
        <IconPlus size={12} /> 필터 추가
      </button>
    </div>
  )
}
