import { useState, type FormEvent } from 'react'
import { useEscClose } from '../lib/useEscClose'

interface Props {
  /** 프리필(연결의 기본 catalog/schema) */
  defaultCatalog?: string
  defaultSchema?: string
  /** 이미 등록된 테이블 재입력 방지용(소문자 "cat.sch.tbl") */
  registered: Set<string>
  onSubmit: (catalog: string, schema: string, table: string) => void
  onClose: () => void
}

/**
 * 찾아보기(서버 드릴다운) 없이 catalog·schema·table을 직접 입력해 등록하는 팝업.
 * 등록은 App의 registerTables(upsertMetadata manual)로 위임 — 서버 왕복 0.
 */
export function RegisterTableDialog({
  defaultCatalog = '',
  defaultSchema = '',
  registered,
  onSubmit,
  onClose
}: Props): JSX.Element {
  const [catalog, setCatalog] = useState(defaultCatalog)
  const [schema, setSchema] = useState(defaultSchema)
  const [table, setTable] = useState('')
  useEscClose(onClose)

  const c = catalog.trim()
  const s = schema.trim()
  const t = table.trim()
  const dup = c && s && t && registered.has(`${c}.${s}.${t}`.toLowerCase())
  const valid = !!c && !!s && !!t && !dup

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!valid) return
    onSubmit(c, s, t)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="테이블 직접 등록"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>테이블 직접 등록</h2>
        <p className="modal-msg">
          catalog·schema·table을 입력해 등록합니다. 서버에 조회하지 않습니다.
        </p>
        <label>
          카탈로그
          <input value={catalog} onChange={(e) => setCatalog(e.target.value)} placeholder="예: iceberg" />
        </label>
        <label>
          스키마
          <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="예: default" />
        </label>
        <label>
          테이블
          <input
            value={table}
            onChange={(e) => setTable(e.target.value)}
            placeholder="예: orders"
            autoFocus
          />
        </label>
        {dup && <p className="modal-msg dup-warn">이미 등록된 테이블이에요.</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            등록
          </button>
        </div>
      </form>
    </div>
  )
}
