// 워크스페이스 세션 영속화(#12): 열린 탭의 SQL·레이아웃을 재시작 후 복원.
// 순수 렌더러 + localStorage(main 무관, explorerWidth/wsSplitRatio 선례와 동일).
// 결과/에러/실행중 상태는 저장하지 않는다 — 복원 시 휘발 필드는 초기화된다.

import type { EditorTab, Pane } from './tabs'

const KEY = 'wsSession'
const VERSION = 1

/** 탭에서 영속하는 필드(휘발 필드 result/error/running/… 제외). */
interface StoredTab {
  id: string
  savedQueryId: string | null
  title: string
  sql: string
  /** dirty(●) 정합을 위해 함께 저장 — 없으면 편집분이 '저장됨'으로 오인된다 */
  baseSql: string
  hostId: string | null
}
interface StoredPane {
  id: string
  activeTabId: string | null
  tabs: StoredTab[]
}
interface SessionBlob {
  v: number
  panes: StoredPane[]
  focusedPaneId: string
}

/** 현재 워크스페이스를 localStorage에 저장(실패는 조용히 무시 — quota 등). */
export function serializeSession(panes: Pane[], focusedPaneId: string): void {
  try {
    const blob: SessionBlob = {
      v: VERSION,
      focusedPaneId,
      panes: panes.map((p) => ({
        id: p.id,
        activeTabId: p.activeTabId,
        tabs: p.tabs.map((t) => ({
          id: t.id,
          savedQueryId: t.savedQueryId,
          title: t.title,
          sql: t.sql,
          baseSql: t.baseSql,
          hostId: t.hostId
        }))
      }))
    }
    localStorage.setItem(KEY, JSON.stringify(blob))
  } catch {
    /* ignore */
  }
}

function restoreTab(t: StoredTab): EditorTab | null {
  if (!t || typeof t.id !== 'string' || typeof t.sql !== 'string') return null
  return {
    id: t.id,
    savedQueryId: typeof t.savedQueryId === 'string' ? t.savedQueryId : null,
    title: typeof t.title === 'string' ? t.title : 'Untitled query',
    sql: t.sql,
    baseSql: typeof t.baseSql === 'string' ? t.baseSql : t.sql,
    hostId: typeof t.hostId === 'string' ? t.hostId : null,
    // 휘발 필드 초기화(결과/실행상태는 복원하지 않는다)
    result: null,
    error: null,
    errorInfo: null,
    running: false,
    requestId: null,
    progress: null
  }
}

/**
 * localStorage에서 세션을 복원. 없거나 손상/버전 불일치면 null(호출부가 기본 스크래치로 폴백).
 * 탭/ pane id는 그대로(verbatim) 복원 — activeTabId/focusedPaneId 참조가 유지된다.
 */
export function hydrateSession(): { panes: Pane[]; focusedPaneId: string } | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const blob = JSON.parse(raw) as SessionBlob
    if (!blob || blob.v !== VERSION || !Array.isArray(blob.panes) || blob.panes.length === 0)
      return null

    const panes: Pane[] = []
    for (const p of blob.panes) {
      if (!p || typeof p.id !== 'string' || !Array.isArray(p.tabs)) return null
      const tabs = p.tabs.map(restoreTab).filter((t): t is EditorTab => t !== null)
      if (tabs.length === 0) return null // 손상 → 전체 폴백
      const activeTabId = tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId : tabs[0].id
      panes.push({ id: p.id, tabs, activeTabId })
    }
    const focusedPaneId = panes.some((p) => p.id === blob.focusedPaneId)
      ? blob.focusedPaneId
      : panes[0].id
    return { panes, focusedPaneId }
  } catch {
    return null
  }
}
