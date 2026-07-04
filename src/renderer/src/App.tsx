import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
import { ResultsPane } from './components/ResultsPane'
import { StatusBar } from './components/StatusBar'
import { SaveQueryDialog, type SaveQueryResult } from './components/SaveQueryDialog'
import { PromptDialog } from './components/PromptDialog'
import { CloseTabDialog } from './components/CloseTabDialog'
import { ConfirmDialog, type ConfirmConfig } from './components/ConfirmDialog'
import { IconChevronLeft, IconPlus, IconRefresh, IconTrash } from './components/icons'
import {
  type EditorTab,
  type Pane,
  isDirty,
  makeBound,
  makePane,
  makeScratch,
  nextUntitled
} from './lib/tabs'

const api = window.api

const EMPTY_LIBRARY: SavedLibrary = { folders: [], queries: [] }

// explorer 사이드바 크기 범위
const MIN_EXPLORER = 190
const MAX_EXPLORER = 460
const DEFAULT_EXPLORER = 264

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
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(
    () => localStorage.getItem('explorerCollapsed') === '1'
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null)

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [library, setLibrary] = useState<SavedLibrary>(EMPTY_LIBRARY)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [promptState, setPromptState] = useState<PromptConfig | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmConfig | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const askConfirm = (cfg: ConfirmConfig): void => setConfirmState(cfg)
  const [rowLimit, setRowLimit] = useState<number | null>(300)
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
  const [panes, setPanes] = useState<Pane[]>(() => [
    makePane([makeScratch('', null, 'Untitled query 1')])
  ])
  const [focusedPaneId, setFocusedPaneId] = useState<string>('')
  const [closingTabId, setClosingTabId] = useState<string | null>(null)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  // 분할 시 왼쪽 pane 비율(0.3~0.7). 저장 대상 탭(pane별 스크래치 저장용)
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem('wsSplitRatio'))
    return Number.isFinite(v) && v >= 0.3 && v <= 0.7 ? v : 0.5
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
    void refreshSaved()
    void api.getSettings().then((s) => setRowLimit(s.rowLimit))
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

  // host가 로드되면 hostId 없는 탭에 기본 연결 채움(모든 pane)
  useEffect(() => {
    if (!selectedHostId) return
    setPanes((prev) =>
      prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t.hostId ? t : { ...t, hostId: selectedHostId }))
      }))
    )
  }, [selectedHostId])

  // library 변경 시: 삭제된 저장 쿼리에 바인딩된 탭은 스크래치로 변환(작업 보존, 모든 pane)
  useEffect(() => {
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
  }, [library])

  const changeRowLimit = (limit: number | null): void => {
    setRowLimit(limit)
    void api.updateSettings({ rowLimit: limit })
  }

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
    const tab = makeBound(q, selectedHostId)
    addTabToFocused(tab)
    return tab
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
    page: number,
    recordHistory: boolean
  ): Promise<void> => {
    const id = crypto.randomUUID()
    updateTab(tabId, { running: true, requestId: id, error: null, errorInfo: null, progress: null })
    try {
      const res = await api.runQuery({ hostId, sql: sqlText, requestId: id, rowLimit, page, recordHistory })
      if (res.ok) {
        updateTab(tabId, { result: res.value, error: null, errorInfo: null })
        // 성공 실행(페이지 이동 재실행 제외) 후 학습된 메타데이터 갱신
        if (recordHistory) void refreshMetadata(hostId)
      } else updateTab(tabId, { error: res.error, errorInfo: res.errorInfo ?? null, result: null })
    } catch (e) {
      updateTab(tabId, { error: e instanceof Error ? e.message : String(e), result: null })
    } finally {
      updateTab(tabId, { running: false, requestId: null, progress: null })
      if (recordHistory) void refreshHistory()
    }
  }

  const runFresh = (tabId: string, sqlText: string, hostId: string): void => {
    const doExecute = (): void => {
      updateTab(tabId, { lastRun: { sql: sqlText, hostId } })
      void executeQuery(tabId, sqlText, hostId, 0, true)
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
    addTabToPane(paneId, makeScratch('', activeTabOf(p!)?.hostId ?? selectedHostId, nextUntitled(allTitles())))
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
  const goToPageInPane = (paneId: string, page: number): void => {
    const t = paneOf(paneId) && activeTabOf(paneOf(paneId)!)
    if (!t?.lastRun || page < 0) return
    void executeQuery(t.id, t.lastRun.sql, t.lastRun.hostId, page, false)
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
    const tab = makeScratch(entry.sql, hostId, nextUntitled(allTitles()))
    addTabToFocused(tab)
    return tab
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
    const views = pane.tabs.map((t) => ({ id: t.id, title: tabTitle(t), dirty: isDirty(t) }))
    const split = panes.length > 1
    return (
      <div
        key={pane.id}
        className={'ws-pane' + (split && pane.id === focusedPane.id ? ' focused' : '')}
        style={split ? { flex: pane.id === panes[0].id ? splitRatio : 1 - splitRatio } : undefined}
        onMouseDownCapture={() => setFocusedPaneId(pane.id)}
        onFocusCapture={() => setFocusedPaneId(pane.id)}
      >
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
          hosts={hosts}
          hostId={pa?.hostId ?? null}
          onSelectHost={(id) => selectHostInPane(pane.id, id)}
          metadata={metadata[pa?.hostId ?? ''] ?? null}
          rowLimit={rowLimit}
          onRowLimitChange={changeRowLimit}
          split={split}
          onToggleSplit={toggleSplit}
        />
        <ResultsPane
          result={pa?.result ?? null}
          error={pa?.error ?? null}
          errorInfo={pa?.errorInfo ?? null}
          running={pa?.running ?? false}
          progress={pa?.progress ?? null}
          onCancel={() => cancelInPane(pane.id)}
          onPrevPage={() => pa?.result && goToPageInPane(pane.id, pa.result.page - 1)}
          onNextPage={() => pa?.result && goToPageInPane(pane.id, pa.result.page + 1)}
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
