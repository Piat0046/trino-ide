import { ipcMain } from 'electron'
import type {
  HostInput,
  IpcResult,
  QueryResultPayload,
  RunQueryRequest
} from '@shared/types'
import type { CreateQueryInput, UpdateQueryInput } from '@shared/types'
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
import { type CancelToken, type ResolvedConn, cancelQuery, runQuery } from './trino/client'

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
    async (_e, req: RunQueryRequest): Promise<IpcResult<QueryResultPayload>> => {
      const stored = getStoredHost(req.hostId)
      if (!stored) return { ok: false, error: '등록된 host를 찾을 수 없습니다.' }

      const token: CancelToken = { cancelled: false }
      const conn = toConn(stored)
      active.set(req.requestId, { token, conn })
      const ranAt = Date.now()
      try {
        const value = await runQuery(conn, req.sql, token)
        // 모든 실행을 자동 기록 (성공)
        addHistory({
          sql: req.sql,
          hostId: req.hostId,
          hostName: stored.name,
          ranAt,
          ok: true,
          rowCount: value.rowCount,
          elapsedMs: value.stats?.elapsedMs
        })
        return { ok: true, value }
      } catch (e) {
        const error = errorMessage(e)
        // 모든 실행을 자동 기록 (실패도 — 고쳐서 재실행할 수 있도록)
        addHistory({
          sql: req.sql,
          hostId: req.hostId,
          hostName: stored.name,
          ranAt,
          ok: false,
          error
        })
        return { ok: false, error }
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
}
