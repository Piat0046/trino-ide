import { useState, type FormEvent } from 'react'
import type { HostConfig, HostEnv, HostInput, IpcResult, QueryResultPayload } from '@shared/types'
import { useEscClose } from '../lib/useEscClose'

interface Props {
  host: HostConfig | null
  onClose: () => void
  onSave: (input: HostInput) => Promise<void>
  onTest: (input: HostInput) => Promise<IpcResult<QueryResultPayload>>
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function HostDialog({ host, onClose, onSave, onTest }: Props): JSX.Element {
  const [name, setName] = useState(host?.name ?? '')
  const [url, setUrl] = useState(host?.url ?? 'http://localhost:8080')
  const [user, setUser] = useState(host?.user ?? '')
  const [catalog, setCatalog] = useState(host?.catalog ?? '')
  const [schema, setSchema] = useState(host?.schema ?? '')
  const [password, setPassword] = useState('')
  const [insecure, setInsecure] = useState(host?.insecure ?? false)
  const [env, setEnv] = useState<HostEnv | ''>(host?.env ?? '')
  const [confirmBeforeRun, setConfirmBeforeRun] = useState(host?.confirmBeforeRun ?? false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [saving, setSaving] = useState(false)
  useEscClose(onClose)

  const buildInput = (): HostInput => ({
    id: host?.id,
    name: name.trim(),
    url: url.trim(),
    user: user.trim(),
    catalog: catalog.trim() || undefined,
    schema: schema.trim() || undefined,
    insecure,
    env: env || undefined,
    confirmBeforeRun: env === 'prod' ? confirmBeforeRun : undefined,
    password: password || undefined
  })

  const valid = name.trim() && url.trim() && user.trim()

  const handleTest = async (): Promise<void> => {
    setTestState('testing')
    setTestMsg('')
    const res = await onTest(buildInput())
    if (res.ok) {
      setTestState('ok')
      setTestMsg('연결 성공 (SELECT 1)')
    } else {
      setTestState('fail')
      setTestMsg(res.error)
    }
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSave(buildInput())
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={host ? '연결 편집' : '연결 추가'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>{host ? 'Host 편집' : 'Host 추가'}</h2>

        <label>
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-trino"
            autoFocus
            required
          />
        </label>
        <label>
          환경
          <select value={env} onChange={(e) => setEnv(e.target.value as HostEnv | '')}>
            <option value="">미지정</option>
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
        </label>
        <label>
          서버 URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8080"
            required
          />
        </label>
        <label>
          사용자
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="trino" required />
        </label>

        <div className="row">
          <label>
            Catalog
            <input value={catalog} onChange={(e) => setCatalog(e.target.value)} placeholder="hive" />
          </label>
          <label>
            Schema
            <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="default" />
          </label>
        </div>

        <label>
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={host?.hasPassword ? '저장됨 — 변경 시에만 입력' : '없으면 비워두세요'}
          />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
          인증서 검증 무시 (https self-signed)
        </label>

        {env === 'prod' && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmBeforeRun}
                onChange={(e) => setConfirmBeforeRun(e.target.checked)}
              />
              이 연결에서 쿼리 실행 전 확인
            </label>
            <p className="muted host-env-hint">켜면 이 연결로 실행할 때마다 확인 창이 뜹니다.</p>
          </>
        )}

        {testState !== 'idle' && (
          <div className={'test-result ' + testState}>
            {testState === 'testing' ? '연결 테스트 중…' : testMsg}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={handleTest} disabled={!valid || testState === 'testing'}>
            연결 테스트
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!valid || saving}>
            저장
          </button>
        </div>
      </form>
    </div>
  )
}
