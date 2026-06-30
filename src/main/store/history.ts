import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HistoryEntry } from '@shared/types'

/** 쿼리 실행 기록은 <userData>/history.json 에 최신순으로 저장한다(최근 MAX_HISTORY개). */
const MAX_HISTORY = 200

function storePath(): string {
  return join(app.getPath('userData'), 'history.json')
}

function readAll(): HistoryEntry[] {
  const p = storePath()
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    return []
  }
}

function writeAll(list: HistoryEntry[]): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8')
}

export function listHistory(): HistoryEntry[] {
  return readAll()
}

export function addHistory(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
  const record: HistoryEntry = { ...entry, id: randomUUID() }
  writeAll([record, ...readAll()].slice(0, MAX_HISTORY))
  return record
}

export function deleteHistory(id: string): void {
  writeAll(readAll().filter((h) => h.id !== id))
}

export function clearHistory(): void {
  writeAll([])
}
