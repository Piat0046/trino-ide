import { type KeyboardEvent } from 'react'
import { FILTER_OPS, type FilterOp, type PreviewFilter } from '../lib/previewQuery'
import { IconPlus, IconX } from './icons'

interface Col {
  name: string
  type: string
}

interface Props {
  columns: Col[]
  filters: PreviewFilter[]
  onChange: (filters: PreviewFilter[]) => void
  /** 값칸 Enter = 조회(재조회) */
  onApply: () => void
  disabled: boolean
}

/**
 * 테이블 프리뷰 필터 바(#54) — `컬럼 | 조건 | 값` 행(여러 개 = AND). ParamBar 패턴 미러.
 * 여기서 바뀐 값은 tab.preview에만 반영되고, 서버 재조회는 "조회"(Enter) 명시 액션에서만.
 */
export function FilterBar({ columns, filters, onChange, onApply, disabled }: Props): JSX.Element {
  const colType = (name: string): string => columns.find((c) => c.name === name)?.type ?? ''
  const update = (i: number, patch: Partial<PreviewFilter>): void =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const remove = (i: number): void => onChange(filters.filter((_, j) => j !== i))
  const add = (): void => {
    const first = columns[0]?.name ?? ''
    onChange([...filters, { column: first, op: 'eq', value: '', colType: colType(first) }])
  }
  const onValueKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onApply()
    }
  }

  return (
    <div className="filter-bar" role="group" aria-label="필터">
      {filters.map((f, i) => (
        <div className="filter-row" role="group" aria-label={`필터 ${i + 1}`} key={i}>
          <select
            className="filter-col"
            value={f.column}
            disabled={disabled}
            aria-label="컬럼"
            onChange={(e) => update(i, { column: e.target.value, colType: colType(e.target.value) })}
          >
            {/* 저장된 컬럼이 현재 결과에 없을 수도 있어 방어적으로 포함 */}
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
          <button
            className="filter-x"
            disabled={disabled}
            aria-label={`필터 ${i + 1} 제거`}
            title="필터 제거"
            onClick={() => remove(i)}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
      <button className="filter-add" disabled={disabled || columns.length === 0} onClick={add}>
        <IconPlus size={12} /> 필터
      </button>
    </div>
  )
}
