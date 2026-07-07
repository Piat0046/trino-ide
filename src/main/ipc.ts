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
import type {
  AppSettings,
  CreateQueryInput,
  DeleteNodeInput,
  ManualUpsertInput,
  RenameNodeInput,
  UpdateQueryInput
} from '@shared/types'
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
import { learnColumnsFromResult, learnMetadataFromSql } from './learnMetadata'
import {
  clearAll as clearAllMetadata,
  clearLearned as clearLearnedMetadata,
  deleteNode as deleteMetadataNode,
  getHostMetadata,
  renameNode as renameMetadataNode,
  upsertManual
} from './store/metadata'
import {
  type CancelToken,
  type ResolvedConn,
  TrinoQueryError,
  cancelQuery,
  runQuery,
  SAFETY_CAP
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
      const recordHistory = req.recordHistory ?? true

      // SQL을 재작성하지 않는다 — 원본을 그대로 1회 실행. 메모리 보호를 위해 SAFETY_CAP까지만
      // 수신 후 서버 쿼리를 취소한다(OFFSET 페이지 재실행·서브쿼리 래핑 없음).
      try {
        const value = await runQuery(conn, req.sql, token, SAFETY_CAP, onProgress)

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
          // 단일 테이블 SELECT * 면 결과 컬럼을 그 테이블에 귀속 학습
          learnColumnsFromResult(req.hostId, req.sql, value.columns, stored.catalog, stored.schema)
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
            // 재작성이 없으므로 line/column이 항상 원본과 일치
            line: e.line,
            column: e.column
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

  // ----- metadata -----
  ipcMain.handle('metadata:get', (_e, hostId: string) => getHostMetadata(hostId))
  ipcMain.handle('metadata:upsert', (_e, input: ManualUpsertInput) => upsertManual(input))
  ipcMain.handle('metadata:rename', (_e, input: RenameNodeInput) => renameMetadataNode(input))
  ipcMain.handle('metadata:delete', (_e, input: DeleteNodeInput) => deleteMetadataNode(input))
  ipcMain.handle('metadata:clearLearned', (_e, hostId: string) => clearLearnedMetadata(hostId))
  ipcMain.handle('metadata:clearAll', (_e, hostId: string) => clearAllMetadata(hostId))

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
