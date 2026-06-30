import { useCallback, useEffect, useState } from 'react'
import type {
  HistoryEntry,
  HostConfig,
  HostInput,
  QueryFolder,
  QueryResultPayload,
  SavedLibrary,
  SavedQuery
} from '@shared/types'
import { Sidebar, type SidebarTab } from './components/Sidebar'
import { HostDialog } from './components/HostDialog'
import { SqlEditor } from './components/SqlEditor'
import { ResultPanel } from './components/ResultPanel'
import { SaveQueryDialog, type SaveQueryResult } from './components/SaveQueryDialog'

const api = window.api

const DEFAULT_SQL = 'SELECT 1'
const EMPTY_LIBRARY: SavedLibrary = { folders: [], queries: [] }

export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostConfig[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('hosts')

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [library, setLibrary] = useState<SavedLibrary>(EMPTY_LIBRARY)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)

  const [sql, setSql] = useState(DEFAULT_SQL)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResultPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)

  const refreshHosts = useCallback(async () => {
    const list = await api.listHosts()
    setHosts(list)
    setSelectedHostId((cur) => cur ?? list[0]?.id ?? null)
  }, [])

  const refreshHistory = useCallback(async () => {
    setHistory(await api.listHistory())
  }, [])

  const refreshSaved = useCallback(async () => {
    setLibrary(await api.listSaved())
  }, [])

  useEffect(() => {
    void refreshHosts()
    void refreshHistory()
    void refreshSaved()
  }, [refreshHosts, refreshHistory, refreshSaved])

  // ----- host CRUD -----
  const openAdd = (): void => {
    setEditingHost(null)
    setDialogOpen(true)
  }
  const openEdit = (h: HostConfig): void => {
    setEditingHost(h)
    setDialogOpen(true)
  }
  const handleSave = async (input: HostInput): Promise<void> => {
    const saved = await api.saveHost(input)
    setDialogOpen(false)
    await refreshHosts()
    setSelectedHostId(saved.id)
  }
  const handleDelete = async (h: HostConfig): Promise<void> => {
    await api.deleteHost(h.id)
    setSelectedHostId((cur) => (cur === h.id ? null : cur))
    await refreshHosts()
  }

  // ----- query execution -----
  const executeQuery = async (sqlText: string, hostId: string): Promise<void> => {
    if (running) return
    const id = crypto.randomUUID()
    setRequestId(id)
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.runQuery({ hostId, sql: sqlText, requestId: id })
      if (res.ok) setResult(res.value)
      else setError(res.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setRequestId(null)
      void refreshHistory() // 모든 실행은 main에서 자동 기록 → 목록 새로고침
    }
  }

  const runQuery = (): void => {
    if (selectedHostId) void executeQuery(sql, selectedHostId)
  }

  const cancelQuery = async (): Promise<void> => {
    if (requestId) await api.cancelQuery(requestId)
  }

  // ----- history actions -----
  const loadHistory = (entry: HistoryEntry): void => {
    setSql(entry.sql)
    if (hosts.some((h) => h.id === entry.hostId)) setSelectedHostId(entry.hostId)
  }
  const runHistory = (entry: HistoryEntry): void => {
    setSql(entry.sql)
    if (hosts.some((h) => h.id === entry.hostId)) setSelectedHostId(entry.hostId)
    void executeQuery(entry.sql, entry.hostId)
  }
  const deleteHistory = async (id: string): Promise<void> => {
    await api.deleteHistory(id)
    await refreshHistory()
  }
  const clearHistory = async (): Promise<void> => {
    await api.clearHistory()
    await refreshHistory()
  }

  // ----- saved query actions -----
  const createFolder = async (): Promise<void> => {
    const name = window.prompt('새 폴더 이름')?.trim()
    if (!name) return
    await api.createFolder(name)
    await refreshSaved()
  }
  const renameFolder = async (folder: QueryFolder): Promise<void> => {
    const name = window.prompt('폴더 이름', folder.name)?.trim()
    if (!name || name === folder.name) return
    await api.renameFolder(folder.id, name)
    await refreshSaved()
  }
  const deleteFolder = async (folder: QueryFolder): Promise<void> => {
    if (!window.confirm(`'${folder.name}' 폴더와 그 안의 쿼리를 모두 삭제할까요?`)) return
    await api.deleteFolder(folder.id)
    await refreshSaved()
  }
  const addQueryToFolder = async (folder: QueryFolder): Promise<void> => {
    if (!sql.trim()) {
      window.alert('에디터가 비어 있습니다.')
      return
    }
    const name = window.prompt('쿼리 이름')?.trim()
    if (!name) return
    await api.createQuery({ folderId: folder.id, name, sql })
    await refreshSaved()
  }
  const loadSaved = (q: SavedQuery): void => {
    setSql(q.sql)
  }
  const runSaved = (q: SavedQuery): void => {
    setSql(q.sql)
    if (selectedHostId) void executeQuery(q.sql, selectedHostId)
    else window.alert('먼저 Hosts 탭에서 실행할 host를 선택하세요.')
  }
  const renameSaved = async (q: SavedQuery): Promise<void> => {
    const name = window.prompt('쿼리 이름', q.name)?.trim()
    if (!name || name === q.name) return
    await api.updateQuery({ id: q.id, name })
    await refreshSaved()
  }
  const deleteSaved = async (q: SavedQuery): Promise<void> => {
    if (!window.confirm(`'${q.name}' 쿼리를 삭제할까요?`)) return
    await api.deleteQuery(q.id)
    await refreshSaved()
  }

  // 에디터의 "저장" → 다이얼로그
  const handleSaveQuery = async (res: SaveQueryResult): Promise<void> => {
    let folderId = res.folderId
    if (res.newFolderName) {
      const folder = await api.createFolder(res.newFolderName)
      folderId = folder.id
    }
    if (!folderId) return
    await api.createQuery({ folderId, name: res.name, sql })
    await refreshSaved()
    setSaveDialogOpen(false)
    setSidebarTab('saved')
  }

  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? null

  return (
    <div className="app">
      <Sidebar
        tab={sidebarTab}
        onTabChange={setSidebarTab}
        hosts={hosts}
        selectedHostId={selectedHostId}
        onSelectHost={setSelectedHostId}
        onAddHost={openAdd}
        onEditHost={openEdit}
        onDeleteHost={handleDelete}
        history={history}
        onLoadHistory={loadHistory}
        onRunHistory={runHistory}
        onDeleteHistory={deleteHistory}
        onClearHistory={clearHistory}
        library={library}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={deleteFolder}
        onAddQueryToFolder={addQueryToFolder}
        onLoadSaved={loadSaved}
        onRunSaved={runSaved}
        onRenameSaved={renameSaved}
        onDeleteSaved={deleteSaved}
      />
      <main className="main">
        <SqlEditor
          sql={sql}
          onChange={setSql}
          onRun={runQuery}
          onCancel={cancelQuery}
          onSave={() => setSaveDialogOpen(true)}
          running={running}
          selectedHost={selectedHost}
        />
        <ResultPanel result={result} error={error} running={running} />
      </main>
      {dialogOpen && (
        <HostDialog
          host={editingHost}
          onClose={() => setDialogOpen(false)}
          onSave={handleSave}
          onTest={api.testHost}
        />
      )}
      {saveDialogOpen && (
        <SaveQueryDialog
          folders={library.folders}
          sqlPreview={sql}
          onClose={() => setSaveDialogOpen(false)}
          onSave={handleSaveQuery}
        />
      )}
    </div>
  )
}
