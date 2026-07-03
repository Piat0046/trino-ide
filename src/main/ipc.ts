import { clipboard, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import type {
  HostInput,
  IpcResult,
  QueryResultPayload,
  RunQueryRequest,
  SaveFileResult,
  SaveTextInput
} from '@shared/types'
import type { AppSettings, CreateQueryInput, UpdateQueryInput } from '@shared/types'
import { decryptPassword, deleteHost, getStoredHost, listHosts, saveHost } from './store/hosts'
import { addHistory, clearHistory, deleteHistory, listHistory } from './store/history'
import {
  createFolder,
  createQuery,
  deleteFolder,
  deleteQuery,
  listSaved,
  renameFolder,
  updateQuery
} from './store/savedQueries'
import { getSettings, updateSettings } from './store/settings'
import { learnMetadataFromSql } from './learnMetadata'
import {
  type CancelToken,
  type ResolvedConn,
  TrinoQueryError,
  canPaginate,
  cancelQuery,
  hasOrderBy,
  runQuery,
  wrapPaginated
} from './trino/client'
import type { QueryErrorInfo } from '@shared/types'

/** 진행 중인 쿼리: requestId -> 토큰 + 접속 정보(서버 측 취소에 필요) */
const active = new Map<string, { token: CancelToken; conn: ResolvedConn }>()

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 저장된 host를 접속 가능한 형태(비밀번호 복호화 포함)로 변환 */
function toConn(h: NonNullable<ReturnType<typeof getStoredHost>>): ResolvedConn {
  return {
    url: h.url,
    user: h.user,
    catalog: h.catalog,
    schema: h.schema,
    insecure: h.insecure,
    password: decryptPassword(h.encryptedPassword)
  }
}

/** 저장 전 입력(HostInput)으로 접속 정보 구성. 수정 중 비밀번호 미입력이면 기존 값 사용 */
function resolveInput(input: HostInput): ResolvedConn {
  let password = input.password
  if ((password === undefined || password === '') && input.id) {
    password = decryptPassword(getStoredHost(input.id)?.encryptedPassword)
  }
  return {
    url: input.url,
    user: input.user,
    catalog: input.catalog,
    schema: input.schema,
    insecure: input.insecure,
    password
  }
}

export function registerIpcHandlers(): void {
  // ----- hosts -----
  ipcMain.handle('hosts:list', () => listHosts())
  ipcMain.handle('hosts:save', (_e, input: HostInput) => saveHost(input))
  ipcMain.handle('hosts:delete', (_e, id: string) => deleteHost(id))

  ipcMain.handle(
    'hosts:test',
    async (_e, input: HostInput): Promise<IpcResult<QueryResultPayload>> => {
      try {
        const value = await runQuery(resolveInput(input), 'SELECT 1', { cancelled: false })
        return { ok: true, value }
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
    }
  )

  // ----- query -----
  ipcMain.handle(
    'query:run',
    async (event, req: RunQueryRequest): Promise<IpcResult<QueryResultPayload>> => {
      const stored = getStoredHost(req.hostId)
      if (!stored) return { ok: false, error: '등록된 host를 찾을 수 없습니다.' }

      const token: CancelToken = { cancelled: false }
      const conn = toConn(stored)
      active.set(req.requestId, { token, conn })
      const ranAt = Date.now()
      // 실행 중 진행 stats를 renderer로 스트리밍(단방향 이벤트)
      const onProgress = (stats: QueryResultPayload['stats']): void => {
        if (stats) event.sender.send('query:progress', { requestId: req.requestId, stats })
      }
      // 요청에 rowLimit이 오면 그 값을, 없으면 저장된 기본 설정을 사용
      const rowLimit = req.rowLimit !== undefined ? req.rowLimit : getSettings().rowLimit
      const page = req.page ?? 0
      const recordHistory = req.recordHistory ?? true

      // 페이지네이션: rowLimit이 숫자이고 SELECT/WITH 단일 문일 때만 OFFSET/LIMIT 래핑
      const paginate = typeof rowLimit === 'number' && rowLimit > 0 && canPaginate(req.sql)
      // 무제한(null)이어도 메모리 보호를 위해 안전 상한까지만 받는다
      const UNLIMITED_CAP = 50_000
      const cap = rowLimit == null ? UNLIMITED_CAP : rowLimit
      // 다음 페이지 존재 판단을 위해 1행 더 받아본다
      const execSql = paginate ? wrapPaginated(req.sql, page * rowLimit, rowLimit + 1) : req.sql
      const fetchCap = paginate ? rowLimit + 1 : cap

      try {
        const value = await runQuery(conn, execSql, token, fetchCap, onProgress)

        if (paginate) {
          const limit = rowLimit as number
          const hasNext = value.rows.length > limit
          if (hasNext) value.rows = value.rows.slice(0, limit)
          value.rowCount = value.rows.length
          value.truncated = false
          value.paginated = true
          value.page = page
          value.pageSize = limit
          value.hasNext = hasNext
          value.orderByWarning = !hasOrderBy(req.sql)
        } else {
          value.pageSize = typeof rowLimit === 'number' ? rowLimit : null
        }

        if (recordHistory) {
          addHistory({
            sql: req.sql,
            hostId: req.hostId,
            hostName: stored.name,
            ranAt,
            ok: true,
            rowCount: value.rowCount,
            elapsedMs: value.stats?.elapsedMs
          })
          // 성공 쿼리에서 catalog/schema/table 학습(best-effort, 실패해도 응답 무영향)
          learnMetadataFromSql(req.hostId, req.sql, stored.catalog, stored.schema)
        }
        return { ok: true, value }
      } catch (e) {
        const error = errorMessage(e)
        let errorInfo: QueryErrorInfo | undefined
        if (e instanceof TrinoQueryError) {
          errorInfo = {
            message: e.message,
            errorName: e.errorName,
            errorType: e.errorType,
            errorCode: e.errorCode,
            // 래핑(페이지네이션)된 SQL이면 line/column이 원본과 어긋나므로 숨긴다
            line: paginate ? undefined : e.line,
            column: paginate ? undefined : e.column
          }
        }
        if (recordHistory) {
          addHistory({
            sql: req.sql,
            hostId: req.hostId,
            hostName: stored.name,
            ranAt,
            ok: false,
            error
          })
        }
        return { ok: false, error, errorInfo }
      } finally {
        active.delete(req.requestId)
      }
    }
  )

  ipcMain.handle('query:cancel', async (_e, requestId: string) => {
    const entry = active.get(requestId)
    if (!entry) return
    entry.token.cancelled = true
    if (entry.token.trinoQueryId) {
      await cancelQuery(entry.conn, entry.token.trinoQueryId)
    }
  })

  // ----- history -----
  ipcMain.handle('history:list', () => listHistory())
  ipcMain.handle('history:delete', (_e, id: string) => deleteHistory(id))
  ipcMain.handle('history:clear', () => clearHistory())

  // ----- saved queries -----
  ipcMain.handle('saved:list', () => listSaved())
  ipcMain.handle('saved:createFolder', (_e, name: string) => createFolder(name))
  ipcMain.handle('saved:renameFolder', (_e, id: string, name: string) => renameFolder(id, name))
  ipcMain.handle('saved:deleteFolder', (_e, id: string) => deleteFolder(id))
  ipcMain.handle('saved:createQuery', (_e, input: CreateQueryInput) => createQuery(input))
  ipcMain.handle('saved:updateQuery', (_e, input: UpdateQueryInput) => updateQuery(input))
  ipcMain.handle('saved:deleteQuery', (_e, id: string) => deleteQuery(id))

  // ----- settings -----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  // ----- clipboard / export -----
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle(
    'file:saveText',
    async (_e, input: SaveTextInput): Promise<SaveFileResult> => {
      const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: input.defaultName })
      if (canceled || !filePath) return { saved: false }
      await writeFile(filePath, input.content, 'utf-8')
      return { saved: true, path: filePath }
    }
  )
  // 외부 브라우저로 열기(http/https만 허용 — 안전)
  ipcMain.handle('system:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
