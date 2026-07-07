import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/types'

/** 앱 설정은 <userData>/settings.json 에 저장. 현재 사용자 설정 항목 없음(향후 확장용). */
const DEFAULT_SETTINGS: AppSettings = {}

function storePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  const p = storePath()
  if (!existsSync(p)) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
