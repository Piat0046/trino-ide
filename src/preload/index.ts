import { contextBridge, ipcRenderer } from 'electron'
import type { TrinoIdeApi } from '@shared/types'

const api: TrinoIdeApi = {
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (input) => ipcRenderer.invoke('hosts:save', input),
  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),
  testHost: (input) => ipcRenderer.invoke('hosts:test', input),
  runQuery: (req) => ipcRenderer.invoke('query:run', req),
  cancelQuery: (requestId) => ipcRenderer.invoke('query:cancel', requestId),
  listHistory: () => ipcRenderer.invoke('history:list'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listSaved: () => ipcRenderer.invoke('saved:list'),
  createFolder: (name) => ipcRenderer.invoke('saved:createFolder', name),
  renameFolder: (id, name) => ipcRenderer.invoke('saved:renameFolder', id, name),
  deleteFolder: (id) => ipcRenderer.invoke('saved:deleteFolder', id),
  createQuery: (input) => ipcRenderer.invoke('saved:createQuery', input),
  updateQuery: (input) => ipcRenderer.invoke('saved:updateQuery', input),
  deleteQuery: (id) => ipcRenderer.invoke('saved:deleteQuery', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveTextFile: (input) => ipcRenderer.invoke('file:saveText', input),
  onQueryProgress: (cb) => {
    const listener = (_e: unknown, payload: Parameters<typeof cb>[0]): void => cb(payload)
    ipcRenderer.on('query:progress', listener)
    return () => ipcRenderer.removeListener('query:progress', listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // contextIsolation 비활성 환경 폴백
  ;(globalThis as unknown as { api: TrinoIdeApi }).api = api
}
