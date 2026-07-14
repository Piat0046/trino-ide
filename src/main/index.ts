import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { disposeAllPreviewSessions, initializePreviewSessions, registerIpcHandlers } from './ipc'
import { listHistory } from './store/history'
import { getStoredHost } from './store/hosts'
import { isBackfilled, markBackfilled } from './store/metadata'
import { learnMetadataFromSql } from './learnMetadata'

/** 최초 1회: 기존 history의 성공 쿼리로 메타데이터를 소급 학습한다(best-effort). */
function backfillMetadataFromHistory(): void {
  try {
    if (isBackfilled()) return
    for (const h of listHistory()) {
      if (!h.ok) continue
      const host = getStoredHost(h.hostId)
      learnMetadataFromSql(h.hostId, h.sql, host?.catalog, host?.schema)
    }
    markBackfilled()
  } catch {
    // 소급 학습 실패는 무시한다.
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    title: 'Trino IDE',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 개발 모드에서는 electron-vite가 주입하는 dev 서버 URL을 로드
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  void initializePreviewSessions().catch(() => undefined)
  backfillMetadataFromHistory()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let previewCleanupStarted = false
let previewCleanupFinished = false
app.on('before-quit', (event) => {
  if (previewCleanupFinished) return
  event.preventDefault()
  if (previewCleanupStarted) return
  previewCleanupStarted = true
  void disposeAllPreviewSessions().finally(() => {
    previewCleanupFinished = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
