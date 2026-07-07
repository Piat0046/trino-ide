import { useState, type KeyboardEvent } from 'react'
import type { ParamDef, ParamValue } from '../lib/queryParams'
import { isValidNumber, paramValueValid } from '../lib/queryParams'
import { IconChevronDown, IconChevronRight, IconX } from './icons'

interface Props {
  defs: ParamDef[]
  values: Record<string, ParamValue>
  onChange: (key: string, value: ParamValue) => void
  /** 실행 중이면 입력 잠금(값이 바뀌는 혼동 방지) */
  disabled: boolean
  /** 실행이 한 번 차단된 뒤에만 빈 필수 필드를 빨강으로(공격적 pristine 빨강 방지) */
  showErrors: boolean
  /** 치환된 최종 SQL(실행될 SQL 보기) */
  previewSql: string
}

/**
 * 실행 대상 문장의 {{param}}을 채우는 인라인 매개변수 바(#34, F27).
 * 값만 바꿔 ⌘↵ 반복 실행하는 흐름을 위해 에디터 하단에 상주한다. 순수 로컬(서버 왕복 0).
 */
export function ParamBar({
  defs,
  values,
  onChange,
  disabled,
  showErrors,
  previewSql
}: Props): JSX.Element {
  const [showSql, setShowSql] = useState(false)

  return (
    <div className="param-bar" role="group" aria-label="매개변수">
      <div className="param-bar-head">
        <span className="param-count">매개변수 {defs.length}</span>
        <button
          className="param-preview-toggle"
          onClick={() => setShowSql((s) => !s)}
          aria-expanded={showSql}
          aria-controls="param-sql-preview"
          title="치환되어 실제로 실행될 SQL"
        >
          {showSql ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span>실행될 SQL {showSql ? '접기' : '보기'}</span>
        </button>
      </div>

      <div className="param-fields">
        {defs.map((def) => (
          <ParamField
            key={def.key}
            def={def}
            value={values[def.key]}
            onChange={(v) => onChange(def.key, v)}
            disabled={disabled}
            showErrors={showErrors}
          />
        ))}
      </div>

      {showSql && (
        <pre className="param-sql-preview" id="param-sql-preview">
          {previewSql}
        </pre>
      )}
    </div>
  )
}

interface FieldProps {
  def: ParamDef
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
  disabled: boolean
  showErrors: boolean
}

/** 빈 필수/형식 오류일 때 보일 힌트 문구(null이면 힌트 없음). */
function hintFor(def: ParamDef, value: ParamValue | undefined, showErrors: boolean): string | null {
  if (def.kind === 'number') {
    const v = typeof value === 'string' ? value : ''
    if (v !== '' && !isValidNumber(v)) return '숫자를 입력하세요' // 형식 오류는 즉시
    if (showErrors && v.trim() === '') return '값을 입력하세요'
    return null
  }
  if (def.kind === 'range') {
    const rv = value && typeof value === 'object' && !Array.isArray(value) ? value : null
    if (rv && rv.start !== '' && rv.end !== '' && rv.start > rv.end)
      return '끝 날짜가 시작보다 빠릅니다' // 역전은 즉시
    if (showErrors && !paramValueValid(def, value)) return '기간을 선택하세요'
    return null
  }
  if (!showErrors || paramValueValid(def, value)) return null
  if (def.kind === 'date') return '날짜를 선택하세요'
  if (def.kind === 'multi') return '값을 하나 이상 추가하세요'
  return '값을 입력하세요'
}

function ParamField({ def, value, onChange, disabled, showErrors }: FieldProps): JSX.Element {
  const invalid = showErrors && !paramValueValid(def, value)
  const hint = hintFor(def, value, showErrors)
  const hintId = hint ? 'phint-' + def.key : undefined
  // range/multi는 컨트롤이 여러 개라 label 대신 role=group(단일 컨트롤 타입만 label)
  const grouped = def.kind === 'range' || def.kind === 'multi'
  const inner = (
    <>
      <span className="param-label" title={def.key}>
        {def.key}
      </span>
      <ParamControl
        def={def}
        value={value}
        onChange={onChange}
        disabled={disabled}
        invalid={invalid}
        hintId={hintId}
      />
      {hint && (
        <span className="param-hint" id={hintId}>
          {hint}
        </span>
      )}
    </>
  )
  const cls = 'param-field' + (invalid ? ' invalid' : '')
  return grouped ? (
    <div className={cls} role="group" aria-label={def.key}>
      {inner}
    </div>
  ) : (
    <label className={cls}>{inner}</label>
  )
}

interface ControlProps {
  def: ParamDef
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
  disabled: boolean
  invalid: boolean
  hintId?: string
}

function ParamControl({ def, value, onChange, disabled, invalid, hintId }: ControlProps): JSX.Element {
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': hintId }
  switch (def.kind) {
    case 'number': {
      const v = typeof value === 'string' ? value : ''
      return (
        <input
          type="text"
          inputMode="decimal"
          className="param-input"
          value={v}
          disabled={disabled}
          placeholder="숫자"
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )
    }
    case 'date': {
      const v = typeof value === 'string' ? value : ''
      return (
        <input
          type="date"
          className="param-input param-date"
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )
    }
    case 'range': {
      const rv =
        value && typeof value === 'object' && !Array.isArray(value) ? value : { start: '', end: '' }
      return (
        <span className="param-control param-range">
          <input
            type="date"
            className="param-input param-date"
            value={rv.start}
            disabled={disabled}
            aria-label={def.key + ' 시작'}
            aria-invalid={invalid || undefined}
            aria-describedby={hintId}
            onChange={(e) => onChange({ start: e.target.value, end: rv.end })}
          />
          <span className="param-range-sep">~</span>
          <input
            type="date"
            className="param-input param-date"
            value={rv.end}
            disabled={disabled}
            aria-label={def.key + ' 끝'}
            aria-invalid={invalid || undefined}
            aria-describedby={hintId}
            onChange={(e) => onChange({ start: rv.start, end: e.target.value })}
          />
        </span>
      )
    }
    case 'multi':
      return (
        <MultiInput
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
          label={def.key}
          invalid={invalid}
          hintId={hintId}
        />
      )
    default: {
      const v = typeof value === 'string' ? value : ''
      return (
        <input
          type="text"
          className="param-input"
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )
    }
  }
}

interface MultiProps {
  items: string[]
  onChange: (v: string[]) => void
  disabled: boolean
  label: string
  invalid: boolean
  hintId?: string
}

/** 값 여러 개를 칩으로 입력(Enter/콤마=추가, ×/Backspace=제거). IN (…) 안에 넣는 용도. */
function MultiInput({ items, onChange, disabled, label, invalid, hintId }: MultiProps): JSX.Element {
  const [draft, setDraft] = useState('')

  const commit = (raw: string): void => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (parts.length) onChange([...items, ...parts])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Enter/콤마 = 칩 추가. ⌘↵(meta/ctrl)도 draft를 먼저 commit하고 그대로 버블시켜(실행) 값 누락을 막는다.
    if (e.key === 'Enter' || e.key === ',') {
      if (draft.trim()) {
        if (!(e.metaKey || e.ctrlKey)) e.preventDefault() // 순수 Enter/콤마만 소비(⌘↵는 실행에 위임)
        commit(draft)
      }
    } else if (e.key === 'Backspace' && draft === '' && items.length) {
      onChange(items.slice(0, -1))
    }
  }
  return (
    <span className="param-control param-multi">
      {items.map((it, i) => (
        <span className="param-chip" key={i}>
          <span className="param-chip-text">{it}</span>
          <button
            className="param-chip-x"
            disabled={disabled}
            aria-label={it + ' 제거'}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <IconX size={11} />
          </button>
        </span>
      ))}
      <input
        type="text"
        className="param-chip-input"
        value={draft}
        disabled={disabled}
        placeholder={items.length ? '' : '+ 값 추가'}
        aria-label={label + ' 값 추가'}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && commit(draft)}
      />
    </span>
  )
}
