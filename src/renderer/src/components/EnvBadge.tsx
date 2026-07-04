import type { HostEnv } from '@shared/types'

/** 배지에 표시할 라벨(대문자). 저장값은 소문자 union이다. */
const ENV_LABEL: Record<HostEnv, string> = { dev: 'DEV', staging: 'STAGING', prod: 'PROD' }

/**
 * env → dot/테두리에 쓸 CSS 색 변수. prod=danger, staging=warn.
 * dev·미지정은 색 신호를 쓰지 않으므로 null(중립).
 */
export function envColor(env?: HostEnv): string | null {
  if (env === 'prod') return 'var(--danger)'
  if (env === 'staging') return 'var(--warn)'
  return null
}

/** 연결 환경 배지. prod/staging은 신호색 pill, dev는 플레인 텍스트, 미지정은 렌더 안 함. */
export function EnvBadge({ env }: { env?: HostEnv }): JSX.Element | null {
  if (!env) return null
  return <span className={'env-badge env-' + env}>{ENV_LABEL[env]}</span>
}
