import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type {
  HistoryEntry,
  HostConfig,
  HostInput,
  HostMetadata,
  MetadataRef,
  PreviewSessionState,
  PreviewSessionUpdate,
  QueryFolder,
  QueryResultPayload,
  SavedLibrary,
  SavedQuery
} from '@shared/types'
import { ActivityRail, type ExplorerSection } from './components/ActivityRail'
import { HostList } from './components/HostList'
import { HistoryList } from './components/HistoryList'
import { SavedPanel } from './components/SavedPanel'
import { MetadataPanel } from './components/MetadataPanel'
import { ColumnEditDialog } from './components/ColumnEditDialog'
import { HostDialog } from './components/HostDialog'
import { SqlEditor } from './components/SqlEditor'
import { scanParams } from './lib/queryParams'
import { ResultsPane } from './components/ResultsPane'
import { InspectorPanel, type InspectorTab } from './components/InspectorPanel'
import type { RecordSnapshot } from './lib/cellFormat'
import { StatusBar } from './components/StatusBar'
import { SaveQueryDialog, type SaveQueryResult } from './components/SaveQueryDialog'
import { PromptDialog } from './components/PromptDialog'
import { BrowserPanel, emptyBrowse, type BrowseData } from './components/BrowserPanel'
import { CloseTabDialog } from './components/CloseTabDialog'
import { ConfirmDialog, type ConfirmConfig } from './components/ConfirmDialog'
import { IconChevronLeft, IconPlus, IconRefresh, IconTrash } from './components/icons'
import {
  type EditorTab,
  type Pane,
  isDirty,
  isDisposable,
  makeBound,
  makePane,
  makePreview,
  makeScratch,
  nextUntitled
} from './lib/tabs'
import { PreviewPane } from './components/PreviewPane'
import { RegisterTableDialog } from './components/RegisterTableDialog'
import {
  buildPreviewSql,
  buildPredicate,
  DEFAULT_MAX_ROWS,
  isOrderable,
  MAX_ROWS_PRESETS,
  resolvePreviewStartTarget,
  type OrderBy,
  type PreviewFilter
} from './lib/previewQuery'
import { derivePreviewPager, shouldApplyPreviewUpdate } from './lib/previewPagination'

type PreviewRuntime = PreviewSessionUpdate

interface PreviewPageTarget {
  sessionId: string
  page: number
  pageSize: number
}

interface PreviewReadFlight extends PreviewPageTarget {
  seq: number
  refreshRequested: boolean
}

const isPreviewRunning = (state: PreviewSessionState): boolean =>
  state === 'starting' || state === 'running'

function previewPageResult(
  runtime: PreviewRuntime,
  sql: string,
  rows: unknown[][]
): QueryResultPayload {
  return {
    columns: runtime.columns,
    rows,
    rowCount: rows.length,
    // Preview 한도 사유는 페이저 세션 상태에서 표시한다. 일반 쿼리 50k 절단 배너를 재사용하지 않는다.
    truncated: false,
    cancelled: runtime.state === 'cancelled',
    stats: runtime.stats,
    executedSql: sql,
    warnings: runtime.warnings,
    infoUri: runtime.infoUri,
    queryId: runtime.queryId
  }
}
import { hydrateSession, serializeSession } from './lib/session'

const api = window.api

const EMPTY_LIBRARY: SavedLibrary = { folders: [], queries: [] }

// explorer 사이드바 크기 범위
const MIN_EXPLORER = 190
const MAX_EXPLORER = 460
const DEFAULT_EXPLORER = 264
const MIN_INSPECTOR = 240
const MAX_INSPECTOR = 560
const DEFAULT_INSPECTOR = 320

interface PromptConfig {
  title: string
  initialValue?: string
  placeholder?: string
  onSubmit: (value: string) => void | Promise<void>
}


export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostConfig[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [section, setSection] = useState<ExplorerSection>('saved')
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('explorerWidth'))
    return Number.isFinite(v) && v >= MIN_EXPLORER && v <= MAX_EXPLORER ? v : DEFAULT_EXPLORER
  })
  // 우측 인스펙터 사이드바(Details/Assistant) — explorer 영속 패턴 미러(#48)
  const [inspectorWidth, setInspectorWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('inspectorWidth'))
    return Number.isFinite(v) && v >= MIN_INSPECTOR && v <= MAX_INSPECTOR ? v : DEFAULT_INSPECTOR
  })
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(
    () => localStorage.getItem('inspectorCollapsed') !== '0' // 기본 접힘
  )
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(
    () => (localStorage.getItem('inspectorTab') === 'assistant' ? 'assistant' : 'details')
  )
  // 선택 행 스냅샷(pane별) — Details는 포커스 pane 것만 렌더
  const [recordByPane, setRecordByPane] = useState<Record<string, RecordSnapshot | null>>({})
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(
    () => localStorage.getItem('explorerCollapsed') === '1'
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null)

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [library, setLibrary] = useState<SavedLibrary>(EMPTY_LIBRARY)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [promptState, setPromptState] = useState<PromptConfig | null>(null)
  // Browser 탭: host별 서버 조회 결과 캐시(세션 한정, 디스크 미영속). 섹션 전환·재펼침 시 서버 0.
  const [browseCache, setBrowseCache] = useState<Record<string, BrowseData>>({})
  const [browserHostId, setBrowserHostId] = useState<string | null>(null)
  const [registerTableOpen, setRegisterTableOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmConfig | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const askConfirm = (cfg: ConfirmConfig): void => setConfirmState(cfg)
  // host별 학습된 메타데이터 캐시(자동완성/관리 섹션 공용). 지연 로드.
  const [metadata, setMetadata] = useState<Record<string, HostMetadata>>({})
  // 관리 섹션이 보여줄 host(미선택이면 활성 탭 host를 따른다)
  const [metaHostId, setMetaHostId] = useState<string | null>(null)
  const [columnDialog, setColumnDialog] = useState<{
    catalog: string
    schema: string
    table: string
    name: string
    type: string
    editing: boolean
  } | null>(null)

  // ----- 멀티 탭 / 분할 pane -----
  // panes.length===1 이면 단일 화면, 2 이면 세로 분할(#3~). focusedPane = 마지막으로 만진 창.
  // 세션 복원(#12): 재시작 시 직전 탭들의 SQL·레이아웃을 localStorage에서 되살린다(한 번만 hydrate).
  const bootRef = useRef<ReturnType<typeof hydrateSession> | undefined>(undefined)
  if (bootRef.current === undefined) bootRef.current = hydrateSession()
  const boot = bootRef.current
  const [panes, setPanes] = useState<Pane[]>(
    () => boot?.panes ?? [makePane([makeScratch('', null, 'Untitled query 1')])]
  )
  const panesRef = useRef(panes)
  panesRef.current = panes
  // Preview 스트림 진행 상태는 재시작 복원 대상이 아닌 런타임 전용 상태다.
  const [previewRuntimeByTab, setPreviewRuntimeByTab] = useState<Record<string, PreviewRuntime>>({})
  const previewRuntimeRef = useRef<Record<string, PreviewRuntime>>({})
  const activePreviewSessionRef = useRef<Record<string, string>>({})
  const previewSqlRef = useRef<Record<string, string>>({})
  const previewHostRef = useRef<Record<string, string>>({})
  const previewPageTargetRef = useRef<Record<string, PreviewPageTarget>>({})
  const previewReadSeqRef = useRef<Record<string, number>>({})
  const previewReadFlightRef = useRef<Record<string, PreviewReadFlight>>({})
  const previewLoadedRef = useRef<
    Record<string, { sessionId: string; offset: number; limit: number; rowCount: number }>
  >({})
  const [focusedPaneId, setFocusedPaneId] = useState<string>(() => boot?.focusedPaneId ?? '')
  // 분할 접기 등으로 사라진 pane의 인스펙터 스냅샷 키를 정리(무해하지만 누수 방지)
  useEffect(() => {
    const ids = new Set(panes.map((p) => p.id))
    setRecordByPane((m) => {
      const kept = Object.keys(m).filter((k) => ids.has(k))
      return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept.map((k) => [k, m[k]]))
    })
  }, [panes])
  // 저장 쿼리 라이브러리가 실제로 로드되기 전에는 reconcile을 돌리지 않는다(복원된 바인딩 탭 오변환 방지)
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [closingTabId, setClosingTabId] = useState<string | null>(null)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  // 분할 시 왼쪽 pane 비율(0.3~0.7). 저장 대상 탭(pane별 스크래치 저장용)
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem('wsSplitRatio'))
    return Number.isFinite(v) && v >= 0.3 && v <= 0.7 ? v : 0.5
  })
  // 에디터↔결과 세로 비율(에디터 몫 0.15~0.85). 분할 시 양쪽 pane 공유.
  const [editorRatio, setEditorRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem('editorRatio'))
    return Number.isFinite(v) && v >= 0.15 && v <= 0.85 ? v : 0.4
  })
  const [saveTargetTabId, setSaveTargetTabId] = useState<string | null>(null)

  // 포커스 pane과 그 활성 탭(파생). focusedPaneId가 아직 없으면 첫 pane.
  const focusedPane = panes.find((p) => p.id === focusedPaneId) ?? panes[0]
  const tabs = focusedPane.tabs
  const activeTab = tabs.find((t) => t.id === focusedPane.activeTabId) ?? tabs[0]
  const activeId = activeTab?.id ?? ''
  const allTitles = (): string[] => panes.flatMap((p) => p.tabs.map((t) => t.title))

  // 탭 id는 전역 유일 → 모든 pane×tab을 스캔해 patch(어느 pane의 탭이든 갱신)
  const updateTab = useCallback((id: string, patch: Partial<EditorTab>): void => {
    setPanes((prev) =>
      prev.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    )
  }, [])

  /** Async Preview 응답을 React state에 커밋하는 시점에도 세션이 여전히 활성인지 확인한다. */
  const updateActivePreviewTab = useCallback(
    (tabId: string, sessionId: string, patch: Partial<EditorTab>): void => {
      setPanes((prev) => {
        if (activePreviewSessionRef.current[tabId] !== sessionId) return prev
        return prev.map((p) => ({
          ...p,
          tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
        }))
      })
    },
    []
  )

  const clearPreviewRuntime = useCallback((tabId: string): void => {
    delete previewRuntimeRef.current[tabId]
    delete previewLoadedRef.current[tabId]
    setPreviewRuntimeByTab((prev) => {
      if (!(tabId in prev)) return prev
      const next = { ...prev }
      delete next[tabId]
      return next
    })
  }, [])

  /**
   * Preview 탭이 소유한 세션을 더 이상 보여주지 않을 때 즉시 stale로 만든 뒤
   * Main process에 cancel → dispose를 요청한다. 늦게 도착한 event/page는 ref guard에서 버려진다.
   */
  const disposePreviewTab = useCallback(
    (tabId: string, sessionId: string | null): void => {
      if (!sessionId || activePreviewSessionRef.current[tabId] !== sessionId) return
      const runtime = previewRuntimeRef.current[tabId]
      delete activePreviewSessionRef.current[tabId]
      delete previewSqlRef.current[tabId]
      delete previewHostRef.current[tabId]
      delete previewPageTargetRef.current[tabId]
      delete previewReadFlightRef.current[tabId]
      previewReadSeqRef.current[tabId] = (previewReadSeqRef.current[tabId] ?? 0) + 1
      clearPreviewRuntime(tabId)
      void (async () => {
        try {
          if (!runtime || isPreviewRunning(runtime.state)) await api.cancelPreview(sessionId)
          await api.disposePreview(sessionId)
        } catch {
          // Main process/app 종료와 경쟁하는 best-effort 정리.
        }
      })()
    },
    [clearPreviewRuntime]
  )

  const loadPreviewPage = useCallback(
    async (tabId: string, sessionId: string, page: number, pageSize: number): Promise<void> => {
      if (activePreviewSessionRef.current[tabId] !== sessionId) return
      const offset = page * pageSize
      const inFlight = previewReadFlightRef.current[tabId]
      if (
        inFlight?.sessionId === sessionId &&
        inFlight.page === page &&
        inFlight.pageSize === pageSize
      ) {
        // 같은 페이지의 진행 event는 진행 중 read를 폐기하지 않고 최신 snapshot 1회로 합친다.
        inFlight.refreshRequested = true
        return
      }

      const seq = (previewReadSeqRef.current[tabId] ?? 0) + 1
      previewReadSeqRef.current[tabId] = seq
      const flight: PreviewReadFlight = {
        sessionId,
        page,
        pageSize,
        seq,
        refreshRequested: false
      }
      previewReadFlightRef.current[tabId] = flight
      previewPageTargetRef.current[tabId] = { sessionId, page, pageSize }

      const isCurrentRead = (): boolean => {
        const target = previewPageTargetRef.current[tabId]
        return (
          activePreviewSessionRef.current[tabId] === sessionId &&
          previewReadSeqRef.current[tabId] === seq &&
          previewReadFlightRef.current[tabId] === flight &&
          target?.sessionId === sessionId &&
          target.page === page &&
          target.pageSize === pageSize
        )
      }

      try {
        do {
          flight.refreshRequested = false
          const res = await api.getPreviewPage({ sessionId, offset, limit: pageSize })
          if (!isCurrentRead()) return
          if (!res.ok) {
            updateActivePreviewTab(tabId, sessionId, {
              error: res.error,
              errorInfo: res.errorInfo ?? null
            })
            return
          }
          if (res.value.sessionId !== sessionId || res.value.offset !== offset) return
          const runtime = previewRuntimeRef.current[tabId]
          if (!runtime || runtime.sessionId !== sessionId) return
          previewLoadedRef.current[tabId] = {
            sessionId,
            offset,
            limit: pageSize,
            rowCount: res.value.rows.length
          }
          updateActivePreviewTab(tabId, sessionId, {
            result: previewPageResult(runtime, previewSqlRef.current[tabId] ?? '', res.value.rows),
            ...(runtime.state === 'failed' ? {} : { error: null, errorInfo: null })
          })
        } while (flight.refreshRequested && isCurrentRead())
      } catch (e) {
        if (!isCurrentRead()) return
        updateActivePreviewTab(tabId, sessionId, {
          error: e instanceof Error ? e.message : String(e),
          errorInfo: null
        })
      } finally {
        if (previewReadFlightRef.current[tabId] === flight)
          delete previewReadFlightRef.current[tabId]
      }
    },
    [updateActivePreviewTab]
  )

  const applyPreviewUpdate = useCallback(
    (tabId: string, update: PreviewSessionUpdate): void => {
      if (activePreviewSessionRef.current[tabId] !== update.sessionId) return
      const previous = previewRuntimeRef.current[tabId]
      // startPreview 초기 응답이 더 최신인 IPC event보다 늦게 돌아와도 행 수/상태를 되돌리지 않는다.
      if (!shouldApplyPreviewUpdate(previous, update)) return

      const runtime: PreviewRuntime = {
        ...previous,
        ...update,
        columns: update.columns.length > 0 ? update.columns : (previous?.columns ?? [])
      }
      previewRuntimeRef.current[tabId] = runtime
      setPreviewRuntimeByTab((prev) =>
        activePreviewSessionRef.current[tabId] === update.sessionId
          ? { ...prev, [tabId]: runtime }
          : prev
      )

      const failed = runtime.state === 'failed'
      updateActivePreviewTab(tabId, update.sessionId, {
        running: isPreviewRunning(runtime.state),
        requestId: null,
        progress: runtime.stats ?? null,
        error: failed ? (runtime.error ?? 'Preview 조회에 실패했습니다.') : null,
        errorInfo: failed ? (runtime.errorInfo ?? null) : null
      })

      const target = previewPageTargetRef.current[tabId]
      if (!target || target.sessionId !== update.sessionId) return
      const offset = target.page * target.pageSize
      const expectedRows = Math.min(target.pageSize, Math.max(0, runtime.availableRows - offset))
      const loaded = previewLoadedRef.current[tabId]
      const loadedRows =
        loaded?.sessionId === update.sessionId &&
        loaded.offset === offset &&
        loaded.limit === target.pageSize
          ? loaded.rowCount
          : -1
      const shownColumns = panesRef.current
        .flatMap((p) => p.tabs)
        .find((t) => t.id === tabId)?.result?.columns
      const columnsChanged =
        !!shownColumns &&
        JSON.stringify(shownColumns.map((c) => [c.name, c.type])) !==
          JSON.stringify(runtime.columns.map((c) => [c.name, c.type]))
      if (loadedRows >= 0) {
        const shownResult = panesRef.current
          .flatMap((p) => p.tabs)
          .find((t) => t.id === tabId)?.result
        if (shownResult && shownResult.rowCount === loadedRows)
          updateActivePreviewTab(tabId, update.sessionId, {
            result: previewPageResult(
              runtime,
              previewSqlRef.current[tabId] ?? shownResult.executedSql,
              shownResult.rows
            )
          })
      }
      // 현재 페이지에 새로 append된 행이 교차할 때만 다시 읽는다. 완료 0행도 컬럼/상태 표시용으로 1회 읽는다.
      if (loadedRows !== expectedRows || columnsChanged)
        void loadPreviewPage(tabId, update.sessionId, target.page, target.pageSize)
    },
    [loadPreviewPage, updateActivePreviewTab]
  )
  // 포커스 pane의 활성 탭 지정
  const setFocusedActive = (tabId: string): void =>
    setPanes((prev) => prev.map((p) => (p.id === focusedPane.id ? { ...p, activeTabId: tabId } : p)))
  // 포커스 pane에 탭 추가 + 활성화
  const addTabToFocused = (tab: EditorTab): void =>
    setPanes((prev) =>
      prev.map((p) =>
        p.id === focusedPane.id ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id } : p
      )
    )
  const activeTabOf = (p: Pane): EditorTab | undefined =>
    p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0]
  const updatePane = (paneId: string, patch: Partial<Pane>): void =>
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, ...patch } : p)))
  const addTabToPane = (paneId: string, tab: EditorTab): void => {
    setFocusedPaneId(paneId)
    setPanes((prev) =>
      prev.map((p) => (p.id === paneId ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id } : p))
    )
  }
  // 다른 pane의 탭을 포커스 pane으로 이동(복제 아님). 원본 pane이 비면 새 스크래치로 대체.
  const movePaneTab = (fromId: string, toId: string, tabId: string): void =>
    setPanes((prev) => {
      const tab = prev.find((p) => p.id === fromId)?.tabs.find((t) => t.id === tabId)
      if (!tab) return prev
      return prev.map((p) => {
        if (p.id === fromId) {
          const rest = p.tabs.filter((t) => t.id !== tabId)
          if (rest.length === 0) {
            const fresh = makeScratch('', selectedHostId, 'Untitled query 1')
            return { ...p, tabs: [fresh], activeTabId: fresh.id }
          }
          return { ...p, tabs: rest, activeTabId: rest[rest.length - 1].id }
        }
        if (p.id === toId) return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        return p
      })
    })

  // 포커스 pane의 활성 탭이 미작업(disposable)이면 그 자리(같은 id)에 교체, 아니면 새 탭 추가.
  // id를 재사용해 탭 슬롯(순서·⌘1..9 인덱스)이 안정 — 누적 없이 내용만 스왑한다.
  const openOrReplaceInFocused = (build: () => EditorTab): EditorTab => {
    const active = activeTabOf(focusedPane)
    const built = build()
    if (active && isDisposable(active)) {
      if (active.preview?.sessionId) disposePreviewTab(active.id, active.preview.sessionId)
      const replaced: EditorTab = {
        ...built,
        id: active.id,
        // 스크래치→스크래치 교체면 슬롯의 기존 제목을 유지(Untitled 번호 건너뜀 방지)
        title:
          built.savedQueryId === null && active.savedQueryId === null ? active.title : built.title
      }
      setPanes((prev) =>
        prev.map((p) =>
          p.id === focusedPane.id
            ? {
                ...p,
                tabs: p.tabs.map((t) => (t.id === active.id ? replaced : t)),
                activeTabId: replaced.id
              }
            : p
        )
      )
      return replaced
    }
    addTabToFocused(built)
    return built
  }

  const tabTitle = (t: EditorTab): string =>
    t.savedQueryId ? (library.queries.find((q) => q.id === t.savedQueryId)?.name ?? t.title) : t.title

  // ----- refresh -----
  const refreshHosts = useCallback(async () => {
    const list = await api.listHosts()
    setHosts(list)
    setSelectedHostId((cur) => cur ?? list[0]?.id ?? null)
  }, [])
  const refreshHistory = useCallback(async () => setHistory(await api.listHistory()), [])
  const refreshSaved = useCallback(async () => setLibrary(await api.listSaved()), [])
  const refreshMetadata = useCallback(async (hostId: string) => {
    const m = await api.getMetadata(hostId)
    setMetadata((cur) => ({ ...cur, [hostId]: m }))
  }, [])

  useEffect(() => {
    void refreshHosts()
    void refreshHistory()
    void refreshSaved().finally(() => setLibraryLoaded(true))
  }, [refreshHosts, refreshHistory, refreshSaved])

  // 첫 pane을 포커스로 초기화(이후 #4에서 pane 내부 상호작용이 갱신)
  useEffect(() => {
    setFocusedPaneId((cur) => cur || panes[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 실행 진행 stats 스트리밍 → 해당 requestId 탭에 반영(모든 pane 스캔)
  useEffect(() => {
    return api.onQueryProgress((pr) => {
      setPanes((prev) =>
        prev.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) => (t.requestId === pr.requestId ? { ...t, progress: pr.stats } : t))
        }))
      )
    })
  }, [])

  // Preview nextUri 소비는 Main process가 계속하고, Renderer는 수신 가능 행 수와 현재 로컬 페이지만 동기화한다.
  useEffect(() => {
    return api.onPreviewUpdate((update) => {
      const entry = Object.entries(activePreviewSessionRef.current).find(
        ([, sessionId]) => sessionId === update.sessionId
      )
      if (entry) applyPreviewUpdate(entry[0], update)
    })
  }, [applyPreviewUpdate])

  // 토스트 자동 소멸
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  // ⌘1..9 로 포커스 pane의 해당 순번 탭 전환
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        const fp = panes.find((p) => p.id === focusedPaneId) ?? panes[0]
        if (idx < fp.tabs.length) {
          e.preventDefault()
          setPanes((prev) =>
            prev.map((p) => (p.id === fp.id ? { ...p, activeTabId: fp.tabs[idx].id } : p))
          )
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panes, focusedPaneId])

  // ⌘\ 로 세로 분할 토글
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSplit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, focusedPaneId, activeTab, selectedHostId])

  // 분할 비율 영속화
  useEffect(() => {
    localStorage.setItem('wsSplitRatio', String(splitRatio))
  }, [splitRatio])
  // 에디터↔결과 비율 영속화
  useEffect(() => {
    localStorage.setItem('editorRatio', String(editorRatio))
  }, [editorRatio])

  // hostId 정리(모든 pane): 삭제된 host를 가리키는 탭(복원분 포함)은 정리하고, 빈 hostId는 기본 연결로 채움.
  // hosts 미로드(length 0) 시엔 복원된 hostId를 성급히 지우지 않는다.
  useEffect(() => {
    setPanes((prev) =>
      prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => {
          const valid = t.hostId && (hosts.length === 0 || hosts.some((h) => h.id === t.hostId))
          const hostId = valid ? t.hostId : selectedHostId
          return hostId === t.hostId ? t : { ...t, hostId }
        })
      }))
    )
  }, [selectedHostId, hosts])

  // Preview 세션을 시작한 host와 탭의 현재 host가 달라지면 이전 쿼리/임시 결과를 정리한다.
  useEffect(() => {
    for (const [tabId, sessionId] of Object.entries(activePreviewSessionRef.current)) {
      const tab = panes.flatMap((p) => p.tabs).find((t) => t.id === tabId)
      if (
        !tab?.preview ||
        tab.preview.sessionId !== sessionId ||
        tab.hostId !== previewHostRef.current[tabId]
      ) {
        disposePreviewTab(tabId, sessionId)
        if (tab?.preview)
          updateTab(tabId, {
            result: null,
            error: null,
            errorInfo: null,
            running: false,
            progress: null,
            preview: { ...tab.preview, page: 0, sessionId: null }
          })
      }
    }
  }, [panes, disposePreviewTab, updateTab])

  // library 변경 시: 삭제된 저장 쿼리에 바인딩된 탭은 스크래치로 변환(작업 보존, 모든 pane).
  // 라이브러리 최초 로드 전에는 건너뛴다 — 복원된 바인딩 탭이 빈 초기 library로 오변환되는 것 방지.
  useEffect(() => {
    if (!libraryLoaded) return
    setPanes((prev) =>
      prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) =>
          t.savedQueryId && !library.queries.some((q) => q.id === t.savedQueryId)
            ? { ...t, savedQueryId: null, baseSql: '' }
            : t
        )
      }))
    )
  }, [library, libraryLoaded])

  // ----- 세션 영속화(#12): 탭 SQL·레이아웃을 재시작 후 복원 -----
  // 타이핑마다 panes가 바뀌므로 디바운스 저장(입력 랙 방지).
  useEffect(() => {
    const id = setTimeout(() => serializeSession(panes, focusedPaneId), 500)
    return () => clearTimeout(id)
  }, [panes, focusedPaneId])
  // 창을 닫거나 숨길 때 즉시 플러시(디바운스 대기분 유실 최소화). 리스너는 1회만 등록.
  const sessionRef = useRef({ panes, focusedPaneId })
  sessionRef.current = { panes, focusedPaneId }
  useEffect(() => {
    const flush = (): void =>
      serializeSession(sessionRef.current.panes, sessionRef.current.focusedPaneId)
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // ----- host CRUD -----
  const openAdd = (): void => {
    setEditingHost(null)
    setDialogOpen(true)
  }
  const openEdit = (h: HostConfig): void => {
    setEditingHost(h)
    setDialogOpen(true)
  }
  const handleSaveHost = async (input: HostInput): Promise<void> => {
    const saved = await api.saveHost(input)
    setDialogOpen(false)
    await refreshHosts()
    selectHost(saved.id)
  }
  const handleDeleteHost = (h: HostConfig): void =>
    askConfirm({
      title: '연결 삭제',
      message: `'${h.name}' 연결을 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteHost(h.id)
        setSelectedHostId((cur) => (cur === h.id ? null : cur))
        await refreshHosts()
      }
    })

  const selectHost = (id: string): void => {
    if (activeId) updateTab(activeId, { hostId: id })
    setSelectedHostId(id)
  }

  // ----- 탭 조작(포커스 pane 대상) -----
  /** 저장 쿼리를 포커스 pane에 연다. 이미 다른 pane에 열려 있으면 그 탭을 포커스 pane으로 이동(중복 금지). */
  const openSaved = (q: SavedQuery): EditorTab => {
    for (const p of panes) {
      const existing = p.tabs.find((t) => t.savedQueryId === q.id)
      if (existing) {
        if (p.id === focusedPane.id) setFocusedActive(existing.id)
        else movePaneTab(p.id, focusedPane.id, existing.id)
        return existing
      }
    }
    return openOrReplaceInFocused(() => makeBound(q, selectedHostId))
  }

  // 탭이 속한 pane에서 닫는다(비면 새 스크래치로 대체)
  const doCloseTab = (id: string): void => {
    const owner = panes.find((p) => p.tabs.some((t) => t.id === id))
    if (!owner) return
    const tab = owner.tabs.find((t) => t.id === id)
    // 실행 중 탭이면 서버 쿼리부터 취소(리소스 정리)
    if (tab?.preview?.sessionId) disposePreviewTab(tab.id, tab.preview.sessionId)
    else if (tab?.running && tab.requestId) void api.cancelQuery(tab.requestId)

    // 창의 마지막 탭 + 분할 상태면 그 창을 접어 1분할로 되돌린다
    const collapse = owner.tabs.length === 1 && panes.length > 1

    setPanes((prev) => {
      if (collapse) return prev.filter((p) => p.id !== owner.id)
      return prev.map((p) => {
        if (p.id !== owner.id) return p
        const idx = p.tabs.findIndex((t) => t.id === id)
        const next = p.tabs.filter((t) => t.id !== id)
        if (next.length === 0) {
          // 단일 창의 마지막 탭 → 항상 탭 1개는 유지되게 새 스크래치로 대체
          const fresh = makeScratch('', selectedHostId, 'Untitled query 1')
          return { ...p, tabs: [fresh], activeTabId: fresh.id }
        }
        const activeTabId =
          p.activeTabId === id ? next[Math.min(idx, next.length - 1)].id : p.activeTabId
        return { ...p, tabs: next, activeTabId }
      })
    })

    // 접힌 창이 포커스였으면 남은 창으로 포커스 이동
    if (collapse) {
      const survivor = panes.find((p) => p.id !== owner.id)
      if (survivor) setFocusedPaneId(survivor.id)
    }
  }

  const closeTab = (id: string): void => {
    const t = panes.flatMap((p) => p.tabs).find((x) => x.id === id)
    if (!t) return
    if (isDirty(t)) setClosingTabId(id)
    else doCloseTab(id)
  }

  // ----- query execution (탭별) -----
  const executeQuery = async (
    tabId: string,
    sqlText: string,
    hostId: string,
    recordHistory = true
  ): Promise<void> => {
    const id = crypto.randomUUID()
    updateTab(tabId, { running: true, requestId: id, error: null, errorInfo: null, progress: null })
    try {
      const res = await api.runQuery({ hostId, sql: sqlText, requestId: id, recordHistory })
      if (res.ok) {
        updateTab(tabId, { result: res.value, error: null, errorInfo: null })
        if (recordHistory) void refreshMetadata(hostId)
      } else updateTab(tabId, { error: res.error, errorInfo: res.errorInfo ?? null, result: null })
    } catch (e) {
      updateTab(tabId, { error: e instanceof Error ? e.message : String(e), result: null })
    } finally {
      updateTab(tabId, { running: false, requestId: null, progress: null })
      if (recordHistory) void refreshHistory() // 프리뷰(#54)는 history 미기록이라 재조회 불필요
    }
  }

  const runFresh = (
    tabId: string,
    sqlText: string,
    hostId: string,
    recordHistory = true
  ): void => {
    const doExecute = (): void => {
      void executeQuery(tabId, sqlText, hostId, recordHistory)
    }
    // prod로 지정 + 옵트인한 연결이면 실행 전 확인(로컬 host.env 조회만 — 서버 호출 없음)
    const host = hosts.find((h) => h.id === hostId)
    if (host?.env === 'prod' && host.confirmBeforeRun) {
      askConfirm({
        title: 'PROD 연결 실행',
        message: `'${host.name}'은 prod로 지정된 연결입니다. 이 문장을 실행할까요?`,
        extra: <div className="sql-preview">{sqlText}</div>,
        confirmLabel: '실행',
        danger: true,
        onConfirm: doExecute
      })
    } else {
      doExecute()
    }
  }


  // ----- 창(pane)별 액션 -----
  const paneOf = (paneId: string): Pane | undefined => panes.find((p) => p.id === paneId)
  const newScratchInPane = (paneId: string): void => {
    const p = paneOf(paneId)
    const active = p ? activeTabOf(p) : undefined
    // 이미 앞에 빈 미작업 스크래치가 있으면 그게 곧 "새 탭" — 빈 탭을 또 만들지 않는다.
    // (빈 바인딩 탭=빈 저장쿼리는 제외 — 타이핑 시 저장되는 별개 탭이라 "+"로 새 스크래치를 열어야 함)
    if (active && isDisposable(active) && active.savedQueryId === null && active.sql.trim() === '') {
      setFocusedPaneId(paneId)
      return
    }
    addTabToPane(paneId, makeScratch('', active?.hostId ?? selectedHostId, nextUntitled(allTitles())))
  }
  const selectHostInPane = (paneId: string, id: string): void => {
    setFocusedPaneId(paneId)
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (t) updateTab(t.id, { hostId: id })
    setSelectedHostId(id)
  }
  const runInPane = (paneId: string, sqlToRun: string): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t || t.running) return
    if (!t.hostId) return void setToast('연결을 먼저 선택하세요.')
    if (!sqlToRun.trim()) return void setToast('실행할 SQL이 없습니다.')
    runFresh(t.id, sqlToRun, t.hostId)
  }
  const cancelInPane = (paneId: string): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (t?.requestId) void api.cancelQuery(t.requestId)
  }

  // ----- 테이블 프리뷰(#54): 단일 nextUri 스트림 + Main 로컬 저장소 페이지 -----
  const previewTab = (paneId: string): EditorTab | undefined => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    return t && t.preview ? t : undefined
  }

  const startPreviewSession = (
    t: EditorTab,
    filters: PreviewFilter[],
    maxRows: number,
    orderBy: OrderBy | null
  ): void => {
    if (!t.preview || !t.hostId) return void (!t.hostId && setToast('연결을 먼저 선택하세요.'))
    const requestedFilters = t.preview.filters
    const applied = filters.filter((f) => f.enabled !== false && buildPredicate(f) !== null)
    const safeMaxRows = MAX_ROWS_PRESETS.includes(maxRows) ? maxRows : DEFAULT_MAX_ROWS
    const sql = buildPreviewSql(t.preview, applied, safeMaxRows, orderBy)

    const doStart = (requireMounted: boolean): void => {
      const mounted = panesRef.current.flatMap((p) => p.tabs).find((tab) => tab.id === t.id)
      // disposable 탭 교체 직후에는 React state가 아직 이전 scratch/Preview를 가리킬 수 있다.
      // 같은 host·table로 실제 mount된 탭만 채택하고, 즉시 실행 경로는 방금 만든 탭을 사용한다.
      const current = resolvePreviewStartTarget(mounted, t, requireMounted)
      if (!current?.preview || !current.hostId) return
      const currentPreview = current.preview
      if (requireMounted && current.hostId !== t.hostId) return void setToast('연결이 바뀌어 Preview를 실행하지 않았습니다.')
      if (requireMounted && currentPreview.sessionId !== t.preview?.sessionId)
        return void setToast('Preview 상태가 바뀌어 이전 확인을 실행하지 않았습니다.')

      const oldSessionId = activePreviewSessionRef.current[current.id]
      if (oldSessionId) disposePreviewTab(current.id, oldSessionId)

      const sessionId = crypto.randomUUID()
      const initial: PreviewRuntime = {
        sessionId,
        state: 'starting',
        columns: current.result?.columns ?? [],
        availableRows: 0,
        storedBytes: 0
      }
      activePreviewSessionRef.current[current.id] = sessionId
      previewSqlRef.current[current.id] = sql
      previewHostRef.current[current.id] = current.hostId
      previewPageTargetRef.current[current.id] = {
        sessionId,
        page: 0,
        pageSize: currentPreview.pageSize
      }
      delete previewLoadedRef.current[current.id]
      previewRuntimeRef.current[current.id] = initial
      setPreviewRuntimeByTab((prev) => ({ ...prev, [current.id]: initial }))
      updateTab(current.id, {
        sql,
        baseSql: sql,
        result: previewPageResult(initial, sql, []),
        error: null,
        errorInfo: null,
        running: true,
        requestId: null,
        progress: null,
        preview: {
          ...currentPreview,
          filters: requestedFilters,
          maxRows: safeMaxRows,
          appliedFilters: applied,
          page: 0,
          orderBy,
          sessionId
        }
      })

      const failStart = (error: string, errorInfo: EditorTab['errorInfo'] = null): void => {
        if (activePreviewSessionRef.current[current.id] !== sessionId) return
        // start IPC 자체가 실패하면 Main에 세션이 없을 수 있다. phantom ownership과 거짓 적용
        // 스냅샷을 버리고, 직전 페이지는 읽기 전용으로 남겨 재시도 맥락을 보존한다.
        disposePreviewTab(current.id, sessionId)
        updateTab(current.id, {
          sql: current.sql,
          baseSql: current.baseSql,
          result: current.result,
          error,
          errorInfo,
          running: false,
          requestId: null,
          progress: null,
          preview: {
            ...currentPreview,
            filters: requestedFilters,
            sessionId: null
          }
        })
      }

      void (async () => {
        try {
          const res = await api.startPreview({
            sessionId,
            hostId: current.hostId as string,
            sql,
            maxRows: safeMaxRows
          })
          if (activePreviewSessionRef.current[current.id] !== sessionId) return
          if (res.ok) applyPreviewUpdate(current.id, res.value)
          else failStart(res.error, res.errorInfo ?? null)
        } catch (e) {
          failStart(e instanceof Error ? e.message : String(e))
        }
      })()
    }

    const host = hosts.find((h) => h.id === t.hostId)
    if (host?.env === 'prod' && host.confirmBeforeRun) {
      askConfirm({
        title: 'PROD 연결 실행',
        message: `'${host.name}'은 prod로 지정된 연결입니다. 이 문장을 실행할까요?`,
        extra: <div className="sql-preview">{sql}</div>,
        confirmLabel: '실행',
        danger: true,
        onConfirm: () => doStart(true)
      })
    } else doStart(false)
  }

  const openTablePreview = (catalog: string, schema: string, table: string): void => {
    const h = browserPanelHostId
    if (!h) return void setToast('연결을 먼저 선택하세요.')
    // 같은 테이블 프리뷰가 이미 열려 있으면 그 탭으로 포커스(open-or-focus)
    for (const p of panes) {
      const found = p.tabs.find(
        (t) =>
          t.preview &&
          t.hostId === h &&
          t.preview.catalog === catalog &&
          t.preview.schema === schema &&
          t.preview.table === table
      )
      if (found) {
        setFocusedPaneId(p.id)
        updatePane(p.id, { activeTabId: found.id })
        return
      }
    }
    const tab = openOrReplaceInFocused(() => makePreview({ catalog, schema, table }, h))
    updateTab(tab.id, { title: table }) // disposable 교체 시 제목 유지되는 걸 테이블명으로 강제
    startPreviewSession(tab, [], tab.preview!.maxRows, null)
  }

  // 조회(⌘↵/Enter/대기칩): 라이브 필터를 적용한 새 스트림, page 0.
  const runPreview = (paneId: string): void => {
    const t = previewTab(paneId)
    if (!t || t.running) return
    startPreviewSession(t, t.preview!.filters, t.preview!.maxRows, t.preview!.orderBy)
  }

  // 페이지 크기는 현재 세션의 로컬 뷰만 page 0으로 다시 읽는다.
  const changePreviewPageSize = (paneId: string, pageSize: number): void => {
    const t = previewTab(paneId)
    if (!t) return
    const size = Number.isFinite(pageSize) ? Math.max(1, Math.min(10000, Math.floor(pageSize))) : 500
    const sessionId = activePreviewSessionRef.current[t.id]
    const runtime = previewRuntimeRef.current[t.id]
    delete previewLoadedRef.current[t.id]
    updateTab(t.id, {
      preview: { ...t.preview!, pageSize: size, page: 0 },
      result:
        runtime && runtime.sessionId === sessionId
          ? previewPageResult(runtime, previewSqlRef.current[t.id] ?? t.sql, [])
          : null
    })
    if (sessionId) void loadPreviewPage(t.id, sessionId, 0, size)
  }

  const changePreviewMaxRows = (paneId: string, maxRows: number): void => {
    const t = previewTab(paneId)
    if (!t || t.running) return
    startPreviewSession(t, t.preview!.appliedFilters ?? [], maxRows, t.preview!.orderBy)
  }

  // 정렬(헤더 클릭) → 명시적 ORDER BY를 가진 새 스트림.
  const setPreviewSort = (paneId: string, column: string, dir: 'asc' | 'desc'): void => {
    const t = previewTab(paneId)
    if (!t) return
    startPreviewSession(t, t.preview!.appliedFilters ?? [], t.preview!.maxRows, { column, dir })
  }

  // 이미 Main process에 저장된 행만 읽는 로컬 페이지 이동. 실행 중에도 가능하다.
  const goToPreviewPage = (paneId: string, delta: number): void => {
    const t = previewTab(paneId)
    if (!t) return
    const page = Math.max(0, t.preview!.page + delta)
    const sessionId = activePreviewSessionRef.current[t.id]
    const runtime = previewRuntimeRef.current[t.id]
    if (!sessionId || !runtime || page === t.preview!.page) return
    // 호출자가 UI disabled 상태를 우회해도 첫 행이 저장되지 않은 다음 페이지로는 이동하지 않는다.
    if (page > t.preview!.page && runtime.availableRows <= page * t.preview!.pageSize) return
    delete previewLoadedRef.current[t.id]
    updateTab(t.id, {
      preview: { ...t.preview!, page },
      result: previewPageResult(runtime, previewSqlRef.current[t.id] ?? t.sql, [])
    })
    void loadPreviewPage(t.id, sessionId, page, t.preview!.pageSize)
  }

  const clearPreviewFilters = (paneId: string): void => {
    const t = previewTab(paneId)
    if (!t || t.running || !t.hostId) return
    updateTab(t.id, { preview: { ...t.preview!, filters: [] } })
    startPreviewSession({ ...t, preview: { ...t.preview!, filters: [] } }, [], t.preview!.maxRows, t.preview!.orderBy)
  }

  const cancelPreviewInPane = (paneId: string): void => {
    const t = previewTab(paneId)
    const sessionId = t && activePreviewSessionRef.current[t.id]
    if (t && sessionId)
      void api.cancelPreview(sessionId).catch((e) => {
        if (activePreviewSessionRef.current[t.id] !== sessionId) return
        setToast(e instanceof Error ? e.message : String(e))
      })
  }

  const openPreviewInEditor = (paneId: string): void => {
    const t = previewTab(paneId)
    if (!t) return
    const sql = buildPreviewSql(t.preview!, t.preview!.filters, t.preview!.maxRows, t.preview!.orderBy)
    addTabToPane(paneId, makeScratch(sql, t.hostId, nextUntitled(allTitles())))
  }
  // 그리드 우클릭 "필터 추가"/"이 값으로 필터" → 프리뷰 필터 행 추가(값 프리필, 자동 실행 안 함)
  const addPreviewFilter = (paneId: string, origIndex: number, value?: unknown): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t?.preview || !t.result) return
    const col = t.result.columns[origIndex]
    if (!col) return
    const f: PreviewFilter = {
      id: crypto.randomUUID(),
      column: col.name,
      op: 'eq',
      value: value != null ? String(value) : '',
      colType: col.type,
      enabled: true
    }
    // 컬럼 우클릭 "필터 추가"/"이 값으로 필터" → 위쪽에 한 칸씩(prepend)
    updateTab(t.id, { preview: { ...t.preview, filters: [f, ...t.preview.filters] } })
  }
  const saveInPane = (paneId: string): void => {
    setFocusedPaneId(paneId)
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t) return
    if (t.savedQueryId) {
      void (async () => {
        await api.updateQuery({ id: t.savedQueryId as string, sql: t.sql })
        updateTab(t.id, { baseSql: t.sql })
        await refreshSaved()
      })()
    } else {
      setSaveTargetTabId(t.id)
      setSaveDialogOpen(true)
    }
  }

  // ----- 분할 토글 / 리사이즈 -----
  const toggleSplit = (): void => {
    if (panes.length === 1) {
      const p2 = makePane([
        makeScratch('', activeTab?.hostId ?? selectedHostId, nextUntitled(allTitles()))
      ])
      setPanes((prev) => [...prev, p2])
      setFocusedPaneId(p2.id)
    } else {
      const keepId = panes[0].id
      setPanes((prev) => {
        const [a, b] = prev
        return [{ ...a, tabs: [...a.tabs, ...b.tabs] }]
      })
      setFocusedPaneId(keepId)
    }
  }
  const startPaneResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const split = (e.currentTarget as HTMLElement).parentElement
    if (!split) return
    const rect = split.getBoundingClientRect()
    const move = (ev: MouseEvent): void =>
      setSplitRatio(Math.min(0.7, Math.max(0.3, (ev.clientX - rect.left) / rect.width)))
    const end = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    document.body.classList.add('col-resizing')
  }

  // 에디터↔결과 세로 크기조절(divider 드래그). 포함 pane 높이 기준 비율, 0.15~0.85 클램프.
  const startEditorResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const pane = (e.currentTarget as HTMLElement).closest('.ws-pane')
    if (!pane) return
    const rect = pane.getBoundingClientRect()
    const move = (ev: MouseEvent): void =>
      setEditorRatio(Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height)))
    const end = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      document.body.classList.remove('row-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    document.body.classList.add('row-resizing')
  }

  // ----- 저장(💾) -----
  const handleSaveQuery = async (res: SaveQueryResult): Promise<void> => {
    const t = panes.flatMap((p) => p.tabs).find((x) => x.id === saveTargetTabId) ?? activeTab
    if (!t) return
    let folderId = res.folderId
    if (res.newFolderName) folderId = (await api.createFolder(res.newFolderName)).id
    if (!folderId) return
    const created = await api.createQuery({ folderId, name: res.name, sql: t.sql })
    await refreshSaved()
    updateTab(t.id, { savedQueryId: created.id, title: res.name, baseSql: t.sql })
    setSaveDialogOpen(false)
    setSaveTargetTabId(null)
    setSection('saved')
    if (pendingCloseTabId === t.id) {
      doCloseTab(t.id)
      setPendingCloseTabId(null)
    }
  }

  // ----- 닫기 확인 모달 동작 -----
  const closingTab = panes.flatMap((p) => p.tabs).find((t) => t.id === closingTabId) ?? null
  const confirmDiscard = (): void => {
    if (closingTabId) doCloseTab(closingTabId)
    setClosingTabId(null)
  }
  const confirmSave = async (): Promise<void> => {
    const t = closingTab
    setClosingTabId(null)
    if (!t) return
    if (t.savedQueryId) {
      await api.updateQuery({ id: t.savedQueryId, sql: t.sql })
      updateTab(t.id, { baseSql: t.sql })
      await refreshSaved()
      doCloseTab(t.id)
    } else {
      // 스크래치 → 다른 이름으로 저장 후 닫기
      setFocusedActive(t.id)
      setPendingCloseTabId(t.id)
      setSaveDialogOpen(true)
    }
  }

  // ----- history actions (항상 새 스크래치 탭) -----
  const openHistoryTab = (entry: HistoryEntry): EditorTab => {
    const hostId = hosts.some((h) => h.id === entry.hostId) ? entry.hostId : selectedHostId
    return openOrReplaceInFocused(() => makeScratch(entry.sql, hostId, nextUntitled(allTitles())))
  }
  const loadHistory = (entry: HistoryEntry): void => {
    openHistoryTab(entry)
  }
  const runHistory = (entry: HistoryEntry): void => {
    const tab = openHistoryTab(entry)
    if (tab.hostId) runFresh(tab.id, tab.sql, tab.hostId)
  }
  const deleteHistory = async (id: string): Promise<void> => {
    await api.deleteHistory(id)
    await refreshHistory()
  }
  const clearHistory = (): void => {
    if (!history.length) return
    askConfirm({
      title: '실행 기록 삭제',
      message: '모든 실행 기록을 지웁니다. 되돌릴 수 없습니다.',
      confirmLabel: '전체 삭제',
      danger: true,
      onConfirm: async () => {
        await api.clearHistory()
        await refreshHistory()
      }
    })
  }

  // ----- saved query actions -----
  const askName = (cfg: PromptConfig): void => setPromptState(cfg)
  const createFolder = (): void =>
    askName({
      title: '새 폴더',
      placeholder: '폴더 이름',
      onSubmit: async (name) => {
        await api.createFolder(name)
        await refreshSaved()
      }
    })
  const renameFolder = (folder: QueryFolder): void =>
    askName({
      title: '폴더 이름 변경',
      initialValue: folder.name,
      onSubmit: async (name) => {
        if (name === folder.name) return
        await api.renameFolder(folder.id, name)
        await refreshSaved()
      }
    })
  const deleteFolder = (folder: QueryFolder): void =>
    askConfirm({
      title: '폴더 삭제',
      message: `'${folder.name}' 폴더와 그 안의 쿼리를 모두 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteFolder(folder.id)
        await refreshSaved()
      }
    })
  // 폴더에 빈 SQL 새 쿼리 생성 후 그 탭 열기
  const createQueryInFolder = async (folder: QueryFolder): Promise<void> => {
    const taken = [...allTitles(), ...library.queries.map((q) => q.name)]
    const created = await api.createQuery({ folderId: folder.id, name: nextUntitled(taken), sql: '' })
    await refreshSaved()
    setSection('saved')
    openSaved(created)
  }
  const loadSaved = (q: SavedQuery): void => {
    openSaved(q)
  }
  const runSaved = (q: SavedQuery): void => {
    const tab = openSaved(q)
    const hostId = tab.hostId ?? selectedHostId
    if (!hostId) {
      setToast('먼저 연결을 선택하세요.')
      return
    }
    // 파라미터가 있으면 raw 템플릿을 그대로 실행하지 않는다(서버 파싱 에러·history 오염 방지) —
    // 탭만 열어 포커스하고 인라인 바에서 값을 채워 실행하도록 유도한다.
    if (scanParams(q.sql).length > 0) {
      setToast('매개변수를 채우고 실행하세요.')
      return
    }
    runFresh(tab.id, tab.sql, hostId)
  }
  const renameSaved = (q: SavedQuery): void =>
    askName({
      title: '쿼리 이름 변경',
      initialValue: q.name,
      onSubmit: async (name) => {
        if (name === q.name) return
        await api.updateQuery({ id: q.id, name })
        await refreshSaved()
      }
    })
  const deleteSaved = (q: SavedQuery): void =>
    askConfirm({
      title: '쿼리 삭제',
      message: `'${q.name}' 쿼리를 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteQuery(q.id)
        await refreshSaved()
      }
    })

  const activeHostId = activeTab?.hostId ?? null
  const selectedHost = hosts.find((h) => h.id === activeHostId) ?? null

  // 활성 host의 학습된 메타데이터를 최초 1회 지연 로드(소급 학습분 포함 → 쿼리 없이도 자동완성)
  useEffect(() => {
    if (activeHostId && metadata[activeHostId] === undefined) void refreshMetadata(activeHostId)
  }, [activeHostId, metadata, refreshMetadata])

  // ----- 메타데이터 관리(섹션) -----
  const metaPanelHostId = metaHostId ?? activeHostId
  // Browser 탭 host(자체 선택, 기본 편집기 연결). host 변경이 자동 조회를 유발하지 않음(명시 버튼만).
  const browserPanelHostId = browserHostId ?? activeHostId
  const applyMeta = (hostId: string, p: Promise<HostMetadata>): void => {
    void p.then((m) => setMetadata((cur) => ({ ...cur, [hostId]: m })))
  }
  const selectMetaHost = (id: string): void => {
    setMetaHostId(id)
    if (metadata[id] === undefined) void refreshMetadata(id)
  }
  const promptAddCatalog = (): void => {
    const h = metaPanelHostId
    if (!h) return
    setPromptState({
      title: '카탈로그 추가 (수동)',
      placeholder: '카탈로그 이름',
      onSubmit: (name) => applyMeta(h, api.upsertMetadata({ hostId: h, catalog: name }))
    })
  }
  const promptAddSchema = (catalog: string): void => {
    const h = metaPanelHostId
    if (!h) return
    setPromptState({
      title: `스키마 추가 · ${catalog}`,
      placeholder: '스키마 이름',
      onSubmit: (name) => applyMeta(h, api.upsertMetadata({ hostId: h, catalog, schema: name }))
    })
  }
  const promptAddTable = (catalog: string, schema: string): void => {
    const h = metaPanelHostId
    if (!h) return
    setPromptState({
      title: `테이블 추가 · ${catalog}.${schema}`,
      placeholder: '테이블 이름',
      onSubmit: (name) => applyMeta(h, api.upsertMetadata({ hostId: h, catalog, schema, table: name }))
    })
  }

  // ----- Browser 탭: 서버 테이블 등록(테이블 단위/일괄) → manual upsert + Metadata 동기 -----
  const registerTables = (hostId: string, catalog: string, schema: string, tables: string[]): void => {
    if (!tables.length) return
    void (async () => {
      let last: HostMetadata | undefined
      for (const table of tables) last = await api.upsertMetadata({ hostId, catalog, schema, table })
      if (last) setMetadata((cur) => ({ ...cur, [hostId]: last! }))
      setToast(
        tables.length === 1
          ? `'${tables[0]}' 등록 완료`
          : `테이블 ${tables.length}개 등록 완료`
      )
    })()
  }
  const openColumnEdit = (
    catalog: string,
    schema: string,
    table: string,
    existing?: { name: string; type: string }
  ): void => {
    if (!metaPanelHostId) return
    setColumnDialog({
      catalog,
      schema,
      table,
      name: existing?.name ?? '',
      type: existing?.type ?? '',
      editing: !!existing
    })
  }
  const submitColumn = (name: string, type: string): void => {
    const h = metaPanelHostId
    const d = columnDialog
    setColumnDialog(null)
    if (!h || !d) return
    const upsert = (): Promise<HostMetadata> =>
      api.upsertMetadata({ hostId: h, catalog: d.catalog, schema: d.schema, table: d.table, column: name, columnType: type })
    // 편집 중 이름이 바뀌었으면 옛 컬럼을 지우고 새로 추가
    if (d.editing && d.name && d.name.toLowerCase() !== name.toLowerCase()) {
      void api
        .deleteMetadata({ hostId: h, catalog: d.catalog, schema: d.schema, table: d.table, column: d.name })
        .then(() => upsert())
        .then((m) => setMetadata((cur) => ({ ...cur, [h]: m })))
    } else {
      applyMeta(h, upsert())
    }
  }
  const renameMeta = (ref: MetadataRef, currentName: string): void => {
    const h = metaPanelHostId
    if (!h) return
    setPromptState({
      title: `이름 변경 · ${currentName}`,
      initialValue: currentName,
      placeholder: '새 이름',
      onSubmit: (newName) => applyMeta(h, api.renameMetadata({ hostId: h, ...ref, newName }))
    })
  }
  const deleteMeta = (ref: MetadataRef, label: string): void => {
    const h = metaPanelHostId
    if (!h) return
    askConfirm({
      title: `'${label}' 삭제`,
      message: '다시 성공 쿼리에 등장하면 재학습됩니다.',
      confirmLabel: '삭제',
      danger: true,
      onConfirm: () => applyMeta(h, api.deleteMetadata({ hostId: h, ...ref }))
    })
  }
  const clearLearnedMeta = (): void => {
    const h = metaPanelHostId
    if (!h) return
    askConfirm({
      title: '학습 데이터 초기화',
      message: '이 연결의 학습된 메타데이터를 모두 지웁니다. 수동 추가 항목은 유지됩니다.',
      confirmLabel: '초기화',
      danger: true,
      onConfirm: () => {
        applyMeta(h, api.clearLearnedMetadata(h))
        setToast('학습 데이터를 초기화했습니다.')
      }
    })
  }

  // 사이드바 크기/접힘 상태 영속화(localStorage)
  useEffect(() => {
    localStorage.setItem('explorerWidth', String(explorerWidth))
  }, [explorerWidth])
  useEffect(() => {
    localStorage.setItem('explorerCollapsed', explorerCollapsed ? '1' : '0')
  }, [explorerCollapsed])
  // 우측 인스펙터 상태 영속화
  useEffect(() => {
    localStorage.setItem('inspectorWidth', String(inspectorWidth))
  }, [inspectorWidth])
  useEffect(() => {
    localStorage.setItem('inspectorCollapsed', inspectorCollapsed ? '1' : '0')
  }, [inspectorCollapsed])
  useEffect(() => {
    localStorage.setItem('inspectorTab', inspectorTab)
  }, [inspectorTab])

  // ⌘⌥B: 인스펙터 토글
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // e.code(물리 키): macOS에서 Option+B는 e.key가 조합문자('∫')로 바뀌므로 code로 매칭
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        setInspectorCollapsed((c) => !c)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // 인스펙터 너비 드래그(우측이라 방향 반전: 왼쪽으로 끌면 넓어짐)
  const startInspectorResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = inspectorWidth
    const move = (ev: MouseEvent): void => {
      const w = Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, startW - (ev.clientX - startX)))
      setInspectorWidth(w)
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

  // 레일 아이콘: 접힌 상태면 펼치고, 같은 섹션을 다시 누르면 접는다(VS Code 관례)
  const onRailChange = (next: ExplorerSection): void => {
    if (explorerCollapsed) {
      setExplorerCollapsed(false)
      setSection(next)
    } else if (next === section) {
      setExplorerCollapsed(true)
    } else {
      setSection(next)
    }
  }

  // 스플리터 드래그로 explorer 너비 조절(min/max 범위)
  const startExplorerResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = explorerWidth
    const move = (ev: MouseEvent): void => {
      const w = Math.min(MAX_EXPLORER, Math.max(MIN_EXPLORER, startW + (ev.clientX - startX)))
      setExplorerWidth(w)
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

  const explorerHeader = (): JSX.Element => {
    const collapseBtn = (
      <button className="icon-btn" title="사이드바 접기" onClick={() => setExplorerCollapsed(true)}>
        <IconChevronLeft size={15} />
      </button>
    )
    if (section === 'connections') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Connections</span>
          <div className="explorer-actions">
            <button className="icon-btn" title="연결 추가" onClick={openAdd}>
              <IconPlus size={15} />
            </button>
            {collapseBtn}
          </div>
        </div>
      )
    }
    if (section === 'saved') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Saved Queries</span>
          <div className="explorer-actions">
            <button className="icon-btn" title="새 폴더" onClick={createFolder}>
              <IconPlus size={15} />
            </button>
            {collapseBtn}
          </div>
        </div>
      )
    }
    if (section === 'metadata') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Metadata</span>
          <div className="explorer-actions">
            <button
              className="icon-btn"
              title="카탈로그 추가 (수동)"
              disabled={!metaPanelHostId}
              onClick={promptAddCatalog}
            >
              <IconPlus size={15} />
            </button>
            <button
              className="icon-btn"
              title="새로고침"
              disabled={!metaPanelHostId}
              onClick={() => metaPanelHostId && void refreshMetadata(metaPanelHostId)}
            >
              <IconRefresh size={15} />
            </button>
            <button
              className="icon-btn"
              title="학습 데이터 초기화"
              disabled={!metaPanelHostId}
              onClick={clearLearnedMeta}
            >
              <IconTrash size={15} />
            </button>
            {collapseBtn}
          </div>
        </div>
      )
    }
    if (section === 'browser') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Browser</span>
          <div className="explorer-actions">{collapseBtn}</div>
        </div>
      )
    }
    return (
      <div className="explorer-header">
        <span className="explorer-title">History</span>
        <div className="explorer-actions">
          <button className="icon-btn" title="전체 삭제" disabled={history.length === 0} onClick={clearHistory}>
            <IconTrash size={15} />
          </button>
          {collapseBtn}
        </div>
      </div>
    )
  }

  // 한 pane(에디터+결과)을 렌더. 분할 시 창별 독립 상태/액션.
  const renderPane = (pane: Pane): JSX.Element => {
    const pa = activeTabOf(pane)
    const views = pane.tabs.map((t) => ({
      id: t.id,
      title: tabTitle(t),
      dirty: isDirty(t),
      preview: t.preview !== null
    }))
    const split = panes.length > 1
    // 프리뷰 탭은 상단(필터) 내용 높이 + 결과가 나머지 가득(고정 분할·v-splitter 없음)
    const isPreview = !!pa?.preview
    const pv = pa?.preview ?? null
    const runtimeForTab = pa ? previewRuntimeByTab[pa.id] : undefined
    const pvRuntime =
      pv?.sessionId && runtimeForTab?.sessionId === pv.sessionId ? runtimeForTab : undefined
    const pvCols = pa?.result?.columns ?? []
    const pvPageSize = pv?.pageSize ?? 0
    const pvRowCount = pa?.result?.rowCount ?? 0
    const pvPage = pv?.page ?? 0
    const pvSortIdx = pv?.orderBy
      ? pvCols.findIndex((c) => c.name === pv.orderBy!.column)
      : -1
    const pager =
      isPreview && pa?.result && pv && pvRuntime
        ? {
            ...derivePreviewPager({
              state: pvRuntime.state,
              availableRows: pvRuntime.availableRows,
              page: pvPage,
              pageSize: pvPageSize,
              currentRows: pvRowCount
            }),
            sortLabel: pv.orderBy?.column,
            sortDir: pv.orderBy?.dir
          }
        : undefined
    return (
      <div
        key={pane.id}
        className={
          'ws-pane' +
          (isPreview ? ' preview-mode' : '') +
          (split && pane.id === focusedPane.id ? ' focused' : '')
        }
        style={
          {
            ...(split ? { flex: pane.id === panes[0].id ? splitRatio : 1 - splitRatio } : {}),
            '--editor-grow': editorRatio,
            '--results-grow': 1 - editorRatio
          } as CSSProperties
        }
        onMouseDownCapture={() => setFocusedPaneId(pane.id)}
        onFocusCapture={() => setFocusedPaneId(pane.id)}
      >
        {pa?.preview ? (
          <PreviewPane
            tabs={views}
            activeTabId={pa.id}
            onSelectTab={(id) => {
              setFocusedPaneId(pane.id)
              updatePane(pane.id, { activeTabId: id })
            }}
            onCloseTab={closeTab}
            onNewTab={() => newScratchInPane(pane.id)}
            split={split}
            onToggleSplit={toggleSplit}
            inspectorOpen={!inspectorCollapsed}
            onToggleInspector={() => setInspectorCollapsed((c) => !c)}
            preview={pa.preview}
            lastRunSql={pa.sql}
            columns={pa.result?.columns ?? []}
            running={pa.running}
            hostName={hosts.find((h) => h.id === pa.hostId)?.name ?? '연결 없음'}
            hostEnv={hosts.find((h) => h.id === pa.hostId)?.env}
            onChangeFilters={(filters) =>
              updateTab(pa.id, { preview: { ...pa.preview!, filters } })
            }
            onChangePageSize={(pageSize) => changePreviewPageSize(pane.id, pageSize)}
            onChangeMaxRows={(maxRows) => changePreviewMaxRows(pane.id, maxRows)}
            onRun={() => runPreview(pane.id)}
            onCancel={() => cancelPreviewInPane(pane.id)}
            onClear={() => clearPreviewFilters(pane.id)}
            onOpenInEditor={() => openPreviewInEditor(pane.id)}
          />
        ) : (
          <SqlEditor
            tabs={views}
            activeTabId={pa?.id ?? ''}
            onSelectTab={(id) => {
              setFocusedPaneId(pane.id)
              updatePane(pane.id, { activeTabId: id })
            }}
            onCloseTab={closeTab}
            onNewTab={() => newScratchInPane(pane.id)}
            sql={pa?.sql ?? ''}
            onChange={(v) => pa && updateTab(pa.id, { sql: v })}
            onRun={(sql) => runInPane(pane.id, sql)}
            onCancel={() => cancelInPane(pane.id)}
            onSave={() => saveInPane(pane.id)}
            running={pa?.running ?? false}
            isScratch={pa ? pa.savedQueryId === null : true}
            savedQueryId={pa?.savedQueryId ?? null}
            onNotify={setToast}
            hosts={hosts}
            hostId={pa?.hostId ?? null}
            onSelectHost={(id) => selectHostInPane(pane.id, id)}
            metadata={metadata[pa?.hostId ?? ''] ?? null}
            split={split}
            onToggleSplit={toggleSplit}
            inspectorOpen={!inspectorCollapsed}
            onToggleInspector={() => setInspectorCollapsed((c) => !c)}
          />
        )}
        {!isPreview && (
          <div
            className="v-splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="에디터와 결과 높이 조절"
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(editorRatio * 100)}
            title="드래그로 높이 조절 · 더블클릭으로 기본 복원"
            onMouseDown={startEditorResize}
            onDoubleClick={() => setEditorRatio(0.4)}
          />
        )}
        <ResultsPane
          result={pa?.result ?? null}
          error={pa?.error ?? null}
          errorInfo={pa?.errorInfo ?? null}
          running={pa?.running ?? false}
          progress={pa?.progress ?? null}
          onCancel={() =>
            isPreview ? cancelPreviewInPane(pane.id) : cancelInPane(pane.id)
          }
          onAddFilter={
            pa?.preview ? (origIndex, value) => addPreviewFilter(pane.id, origIndex, value) : undefined
          }
          pager={pager}
          onPrevPage={() => goToPreviewPage(pane.id, -1)}
          onNextPage={() => goToPreviewPage(pane.id, 1)}
          previewSort={
            isPreview && pv?.orderBy && pvSortIdx >= 0
              ? { origIndex: pvSortIdx, dir: pv.orderBy.dir }
              : undefined
          }
          rowIndexOffset={isPreview ? pvPage * pvPageSize : 0}
          streamingPreview={isPreview}
          previewState={isPreview ? pvRuntime?.state : undefined}
          previewAvailableRows={isPreview ? (pvRuntime?.availableRows ?? 0) : undefined}
          resultKey={
            pa
              ? isPreview && pv
                ? `${pv.sessionId ?? 'none'}:${pv.page}:${pv.pageSize}`
                : `${pa.id}:${pa.result?.queryId ?? pa.requestId ?? (pa.result ? pa.sql : 'empty')}`
              : 'empty-pane'
          }
          onServerSort={
            isPreview
              ? (origIndex, dir) => {
                  const col = pvCols[origIndex]
                  if (!col) return
                  if (!isOrderable(col.type))
                    return void setToast(`'${col.name}'(${col.type})은 정렬할 수 없어요.`)
                  setPreviewSort(pane.id, col.name, dir)
                }
              : undefined
          }
          onSelectRecord={(snap) =>
            setRecordByPane((m) =>
              // null→null 무변경이면 같은 참조 반환(불필요한 재렌더·루프 방지)
              (m[pane.id] ?? null) === null && snap === null ? m : { ...m, [pane.id]: snap }
            )
          }
        />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-body">
        <ActivityRail active={section} collapsed={explorerCollapsed} onChange={onRailChange} />
        {!explorerCollapsed && (
        <aside className="explorer" style={{ width: explorerWidth }}>
          {explorerHeader()}
          {section === 'connections' && (
            <HostList
              hosts={hosts}
              selectedHostId={activeHostId}
              onSelect={selectHost}
              onEdit={openEdit}
              onDelete={handleDeleteHost}
            />
          )}
          {section === 'saved' && (
            <SavedPanel
              library={library}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onAddQuery={createQueryInFolder}
              onLoadQuery={loadSaved}
              onRunQuery={runSaved}
              onRenameQuery={renameSaved}
              onDeleteQuery={deleteSaved}
            />
          )}
          {section === 'history' && (
            <HistoryList
              history={history}
              liveHostIds={new Set(hosts.map((h) => h.id))}
              onLoad={loadHistory}
              onRun={runHistory}
              onDelete={deleteHistory}
            />
          )}
          {section === 'metadata' && (
            <MetadataPanel
              hosts={hosts}
              hostId={metaPanelHostId}
              metadata={metaPanelHostId ? metadata[metaPanelHostId] ?? null : null}
              onSelectHost={selectMetaHost}
              onAddSchema={promptAddSchema}
              onAddTable={promptAddTable}
              onColumnEdit={openColumnEdit}
              onRename={renameMeta}
              onDelete={deleteMeta}
            />
          )}
          {section === 'browser' && (
            <BrowserPanel
              hosts={hosts}
              hostId={browserPanelHostId}
              onSelectHost={(id) => {
                setBrowserHostId(id)
                if (metadata[id] === undefined) void refreshMetadata(id) // 로컬 스토어 읽기(등록됨 판정용)
              }}
              metadata={browserPanelHostId ? metadata[browserPanelHostId] ?? null : null}
              cache={(browserPanelHostId && browseCache[browserPanelHostId]) || emptyBrowse}
              onCache={(fn) => {
                const h = browserPanelHostId
                if (!h) return
                setBrowseCache((c) => ({ ...c, [h]: fn(c[h] ?? emptyBrowse) }))
              }}
              onRegisterTables={(catalog, schema, tables) =>
                browserPanelHostId &&
                registerTables(browserPanelHostId, catalog, schema, tables)
              }
              onUnregister={(catalog, schema, table) => {
                const h = browserPanelHostId
                if (!h) return
                void api.deleteMetadata({ hostId: h, catalog, schema, table }).then((m) => {
                  setMetadata((cur) => ({ ...cur, [h]: m }))
                  setToast(`'${table}' 등록 해제됨`)
                })
              }}
              onPreviewTable={openTablePreview}
              onManualRegister={() => setRegisterTableOpen(true)}
            />
          )}
        </aside>
        )}
        {!explorerCollapsed && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            title="드래그로 크기 조절 · 더블클릭으로 접기"
            onMouseDown={startExplorerResize}
            onDoubleClick={() => setExplorerCollapsed(true)}
          />
        )}

        <div className="workspace">
          <div className="ws-split">
            {renderPane(panes[0])}
            {panes.length > 1 && (
              <div
                className="ws-splitter"
                role="separator"
                aria-orientation="vertical"
                title="드래그로 창 크기 조절"
                onMouseDown={startPaneResize}
              />
            )}
            {panes.length > 1 && renderPane(panes[1])}
          </div>
        </div>

        {!inspectorCollapsed && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            title="드래그로 크기 조절 · 더블클릭으로 접기"
            onMouseDown={startInspectorResize}
            onDoubleClick={() => setInspectorCollapsed(true)}
          />
        )}
        {!inspectorCollapsed && (
          <div className="inspector-wrap" style={{ width: inspectorWidth }}>
            <InspectorPanel
              tab={inspectorTab}
              onTab={setInspectorTab}
              onClose={() => setInspectorCollapsed(true)}
              record={recordByPane[focusedPaneId] ?? null}
              hasResult={activeTab?.result != null}
              hasRows={(activeTab?.result?.rowCount ?? 0) > 0}
              running={activeTab?.running ?? false}
              hasError={activeTab?.error != null}
            />
          </div>
        )}
      </div>

      <StatusBar
        selectedHost={selectedHost}
        running={activeTab?.running ?? false}
        result={activeTab?.result ?? null}
        error={activeTab?.error ?? null}
      />

      {dialogOpen && (
        <HostDialog
          host={editingHost}
          onClose={() => setDialogOpen(false)}
          onSave={handleSaveHost}
          onTest={api.testHost}
        />
      )}
      {saveDialogOpen && (
        <SaveQueryDialog
          folders={library.folders}
          sqlPreview={activeTab?.sql ?? ''}
          onClose={() => {
            setSaveDialogOpen(false)
            setPendingCloseTabId(null)
          }}
          onSave={handleSaveQuery}
        />
      )}
      {promptState && (
        <PromptDialog
          title={promptState.title}
          initialValue={promptState.initialValue}
          placeholder={promptState.placeholder}
          onClose={() => setPromptState(null)}
          onSubmit={async (value) => {
            await promptState.onSubmit(value)
            setPromptState(null)
          }}
        />
      )}
      {registerTableOpen && browserPanelHostId && (
        <RegisterTableDialog
          defaultCatalog={hosts.find((h) => h.id === browserPanelHostId)?.catalog ?? ''}
          defaultSchema={hosts.find((h) => h.id === browserPanelHostId)?.schema ?? ''}
          registered={
            new Set(
              Object.entries(metadata[browserPanelHostId]?.catalogs ?? {}).flatMap(([c, cat]) =>
                Object.entries(cat.schemas).flatMap(([s, sch]) =>
                  Object.entries(sch.tables)
                    .filter(([, t]) => t.source === 'manual')
                    .map(([t]) => `${c}.${s}.${t}`.toLowerCase())
                )
              )
            )
          }
          onClose={() => setRegisterTableOpen(false)}
          onSubmit={(catalog, schema, table) => {
            registerTables(browserPanelHostId, catalog, schema, [table])
            setRegisterTableOpen(false)
          }}
        />
      )}
      {columnDialog && (
        <ColumnEditDialog
          parent={`${columnDialog.catalog}.${columnDialog.schema}.${columnDialog.table}`}
          initialName={columnDialog.name}
          initialType={columnDialog.type}
          editing={columnDialog.editing}
          onSubmit={submitColumn}
          onClose={() => setColumnDialog(null)}
        />
      )}
      {closingTab && (
        <CloseTabDialog
          tabTitle={tabTitle(closingTab)}
          onSave={confirmSave}
          onDiscard={confirmDiscard}
          onCancel={() => setClosingTabId(null)}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          {...confirmState}
          onCancel={() => setConfirmState(null)}
          onConfirm={() => {
            confirmState.onConfirm()
            setConfirmState(null)
          }}
        />
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  )
}
