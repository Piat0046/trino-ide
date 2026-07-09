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
  QueryFolder,
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
import { buildPreviewSql, type PreviewFilter } from './lib/previewQuery'
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
    if (tab?.running && tab.requestId) void api.cancelQuery(tab.requestId)

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

  // ----- 테이블 프리뷰(#54): recordHistory:false로 history·학습·그리드 무오염 -----
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
    runFresh(tab.id, tab.sql, h, false)
  }
  const runPreview = (paneId: string): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t?.preview || t.running) return
    if (!t.hostId) return void setToast('연결을 먼저 선택하세요.')
    const sql = buildPreviewSql(t.preview, t.preview.filters, t.preview.limit)
    updateTab(t.id, { sql }) // 마지막 실행 SQL(세션 degrade + staged 판정 기준)
    runFresh(t.id, sql, t.hostId, false)
  }
  const openPreviewInEditor = (paneId: string): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t?.preview) return
    const sql = buildPreviewSql(t.preview, t.preview.filters, t.preview.limit)
    addTabToPane(paneId, makeScratch(sql, t.hostId, nextUntitled(allTitles())))
  }
  // 그리드 우클릭 "필터 추가"/"이 값으로 필터" → 프리뷰 필터 행 추가(값 프리필, 자동 실행 안 함)
  const addPreviewFilter = (paneId: string, origIndex: number, value?: unknown): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t?.preview || !t.result) return
    const col = t.result.columns[origIndex]
    if (!col) return
    const f: PreviewFilter = {
      column: col.name,
      op: 'eq',
      value: value != null ? String(value) : '',
      colType: col.type
    }
    updateTab(t.id, { preview: { ...t.preview, filters: [...t.preview.filters, f] } })
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
    return (
      <div
        key={pane.id}
        className={'ws-pane' + (split && pane.id === focusedPane.id ? ' focused' : '')}
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
            hostLabel={
              (hosts.find((h) => h.id === pa.hostId)?.name ?? '연결 없음') +
              ` · ${pa.preview.catalog}.${pa.preview.schema}.${pa.preview.table}`
            }
            onChangeFilters={(filters) =>
              updateTab(pa.id, { preview: { ...pa.preview!, filters } })
            }
            onChangeLimit={(limit) => updateTab(pa.id, { preview: { ...pa.preview!, limit } })}
            onRun={() => runPreview(pane.id)}
            onCancel={() => cancelInPane(pane.id)}
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
        <ResultsPane
          result={pa?.result ?? null}
          error={pa?.error ?? null}
          errorInfo={pa?.errorInfo ?? null}
          running={pa?.running ?? false}
          progress={pa?.progress ?? null}
          onCancel={() => cancelInPane(pane.id)}
          onAddFilter={
            pa?.preview ? (origIndex, value) => addPreviewFilter(pane.id, origIndex, value) : undefined
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
