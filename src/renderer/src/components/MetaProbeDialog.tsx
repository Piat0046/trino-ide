import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryErrorInfo } from '@shared/types'
import { useEscClose } from '../lib/useEscClose'
import { parseNames } from '../lib/showQueries'
import { IconSearch } from './icons'

const api = window.api

interface Props {
  /** 모달 제목(예: "스키마 조회 · iceberg") */
  title: string
  /** 실행할 SHOW SQL(부제에 그대로 노출 — 실행 투명성 + 서버 비용 라벨) */
  sql: string
  hostId: string
  /** 이미 등록된 이름(소문자) — 중복 표시/비활성 */
  existing: Set<string>
  /** 선택 항목 등록 */
  onRegister: (names: string[]) => void
  onClose: () => void
}

type Status = 'loading' | 'ok' | 'error'

/**
 * 서버 SHOW 목록을 조회해 다중 선택으로 메타데이터에 등록하는 모달(#52).
 * 실행은 query:run(recordHistory:false)로 — history·자동학습·메인 그리드를 오염시키지 않는다.
 * 명시 클릭 1회 = 서버 왕복 1회(자동 조회 없음).
 */
export function MetaProbeDialog({
  title,
  sql,
  hostId,
  existing,
  onRegister,
  onClose
}: Props): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [names, setNames] = useState<string[]>([])
  const [errMsg, setErrMsg] = useState<{ name?: string; message: string } | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  const reqRef = useRef<string | null>(null)
  const statusRef = useRef<Status>('loading')
  statusRef.current = status
  // 닫기: 로딩 중이면 in-flight SHOW를 서버에서 취소하고 닫는다(요청 안 한 서버 작업 방지).
  // 백드롭·Esc·취소 버튼·로딩 취소 모두 이 경로로 일원화(서로 다른 부작용 제거).
  const close = (): void => {
    if (statusRef.current === 'loading' && reqRef.current) void api.cancelQuery(reqRef.current)
    reqRef.current = null
    onClose()
  }
  useEscClose(close)

  // 모달 진입 시 즉시 1회 조회(명시 액션 — 자동 재조회 없음)
  const runProbe = (): void => {
    setStatus('loading')
    setErrMsg(null)
    const requestId = crypto.randomUUID()
    reqRef.current = requestId
    void api
      .runQuery({ hostId, sql, requestId, recordHistory: false })
      .then((res) => {
        if (reqRef.current !== requestId) return // 취소/재조회로 무효
        if (res.ok) {
          setNames(parseNames(res.value))
          setStatus('ok')
        } else {
          const info = res.errorInfo as QueryErrorInfo | undefined
          setErrMsg({ name: info?.errorName, message: res.error })
          setStatus('error')
        }
      })
      .catch((e) => {
        if (reqRef.current !== requestId) return
        setErrMsg({ message: e instanceof Error ? e.message : String(e) })
        setStatus('error')
      })
  }
  useEffect(runProbe, [hostId, sql])

  const q = find.trim().toLowerCase()
  const shown = useMemo(
    () => (q ? names.filter((n) => n.toLowerCase().includes(q)) : names),
    [names, q]
  )
  const toggle = (name: string): void =>
    setChecked((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const selected = [...checked].filter((n) => !existing.has(n.toLowerCase()))
  const [registering, setRegistering] = useState(false)
  const submit = (): void => {
    if (!selected.length || registering) return
    setRegistering(true) // 등록 중 더블클릭 차단(등록 완료 시 App이 모달을 닫음)
    onRegister(selected)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal meta-probe"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="probe-sub">
          <code>{sql}</code>
          <span className="probe-cost" title="사용자 클릭 1회당 서버에 SHOW 1회만 실행합니다">
            서버 왕복 1회
          </span>
        </div>

        {status === 'loading' && (
          <div className="test-result testing">
            서버에서 조회 중…
            <button className="probe-cancel" onClick={close}>
              취소
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="test-result fail">
            {errMsg?.name ? errMsg.name + ' · ' : ''}
            {errMsg?.message ?? '조회 실패'}
            <button className="probe-retry" onClick={runProbe}>
              다시 조회
            </button>
          </div>
        )}

        {status === 'ok' && (
          <>
            <div className="insp-find probe-find">
              <IconSearch size={13} />
              <input
                type="text"
                value={find}
                placeholder="검색…"
                aria-label="검색"
                autoFocus
                onChange={(e) => setFind(e.target.value)}
              />
            </div>
            {shown.length === 0 ? (
              <div className="empty">
                {names.length === 0
                  ? '표시할 항목이 없습니다. (없거나 조회 권한이 없음)'
                  : '검색 결과가 없습니다.'}
              </div>
            ) : (
              <div className="list probe-list">
                {shown.map((name) => {
                  const already = existing.has(name.toLowerCase())
                  return (
                    <label
                      key={name}
                      className={'checkbox probe-item' + (already ? ' already' : '')}
                    >
                      <input
                        type="checkbox"
                        checked={already || checked.has(name)}
                        disabled={already}
                        onChange={() => toggle(name)}
                      />
                      <span className="probe-name" title={name}>
                        {name}
                      </span>
                      {already && <span className="meta-badge">등록됨</span>}
                    </label>
                  )
                })}
              </div>
            )}
            <div className="probe-count">
              목록 {q && shown.length !== names.length ? `${shown.length}/${names.length}` : names.length}{' '}
              · 선택 {selected.length}
            </div>
          </>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={close}>
            취소
          </button>
          <button
            type="button"
            className="primary"
            disabled={selected.length === 0 || registering}
            onClick={submit}
          >
            {registering ? '등록 중…' : selected.length ? `등록 (${selected.length})` : '등록'}
          </button>
        </div>
      </div>
    </div>
  )
}
