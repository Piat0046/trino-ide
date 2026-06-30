import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CreateQueryInput,
  QueryFolder,
  SavedLibrary,
  SavedQuery,
  UpdateQueryInput
} from '@shared/types'

/** 저장 쿼리 라이브러리는 <userData>/saved-queries.json 에 보관한다. */

function storePath(): string {
  return join(app.getPath('userData'), 'saved-queries.json')
}

function read(): SavedLibrary {
  const p = storePath()
  if (!existsSync(p)) return { folders: [], queries: [] }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return {
      folders: Array.isArray(parsed?.folders) ? parsed.folders : [],
      queries: Array.isArray(parsed?.queries) ? parsed.queries : []
    }
  } catch {
    return { folders: [], queries: [] }
  }
}

function write(lib: SavedLibrary): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(lib, null, 2), 'utf-8')
}

export function listSaved(): SavedLibrary {
  return read()
}

export function createFolder(name: string): QueryFolder {
  const lib = read()
  const folder: QueryFolder = { id: randomUUID(), name, createdAt: Date.now() }
  lib.folders.push(folder)
  write(lib)
  return folder
}

export function renameFolder(id: string, name: string): void {
  const lib = read()
  const folder = lib.folders.find((f) => f.id === id)
  if (!folder) throw new Error('폴더를 찾을 수 없습니다.')
  folder.name = name
  write(lib)
}

/** 폴더 삭제 시 그 안의 쿼리도 함께 삭제한다. */
export function deleteFolder(id: string): void {
  const lib = read()
  lib.folders = lib.folders.filter((f) => f.id !== id)
  lib.queries = lib.queries.filter((q) => q.folderId !== id)
  write(lib)
}

export function createQuery(input: CreateQueryInput): SavedQuery {
  const lib = read()
  if (!lib.folders.some((f) => f.id === input.folderId)) {
    throw new Error('대상 폴더가 존재하지 않습니다.')
  }
  const now = Date.now()
  const query: SavedQuery = {
    id: randomUUID(),
    folderId: input.folderId,
    name: input.name,
    sql: input.sql,
    createdAt: now,
    updatedAt: now
  }
  lib.queries.push(query)
  write(lib)
  return query
}

export function updateQuery(input: UpdateQueryInput): SavedQuery {
  const lib = read()
  const query = lib.queries.find((q) => q.id === input.id)
  if (!query) throw new Error('쿼리를 찾을 수 없습니다.')
  if (input.name !== undefined) query.name = input.name
  if (input.sql !== undefined) query.sql = input.sql
  if (input.folderId !== undefined) query.folderId = input.folderId
  query.updatedAt = Date.now()
  write(lib)
  return query
}

export function deleteQuery(id: string): void {
  const lib = read()
  lib.queries = lib.queries.filter((q) => q.id !== id)
  write(lib)
}
