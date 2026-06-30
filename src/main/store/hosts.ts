import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostConfig, HostInput } from '@shared/types'

/**
 * host 설정은 <userData>/hosts.json 에 저장한다.
 * 비밀번호는 Electron safeStorage(OS 키체인 기반)로 암호화하여 같은 파일에
 * `enc:<base64>` 형태로 보관한다. 키체인을 못 쓰는 환경에서는 `plain:<base64>`
 * 폴백을 사용한다(평문 base64 — 난독화 수준이며 보안이 아님).
 */

interface StoredHost {
  id: string
  name: string
  url: string
  user: string
  catalog?: string
  schema?: string
  insecure?: boolean
  encryptedPassword?: string
}

function storePath(): string {
  return join(app.getPath('userData'), 'hosts.json')
}

function readAll(): StoredHost[] {
  const p = storePath()
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as StoredHost[]) : []
  } catch {
    return []
  }
}

function writeAll(hosts: StoredHost[]): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(hosts, null, 2), 'utf-8')
}

function encryptPassword(password: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(password).toString('base64')
  }
  return 'plain:' + Buffer.from(password, 'utf-8').toString('base64')
}

export function decryptPassword(stored?: string): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return undefined
    }
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf-8')
  }
  return undefined
}

function toConfig(h: StoredHost): HostConfig {
  return {
    id: h.id,
    name: h.name,
    url: h.url,
    user: h.user,
    catalog: h.catalog,
    schema: h.schema,
    insecure: h.insecure,
    hasPassword: Boolean(h.encryptedPassword)
  }
}

export function listHosts(): HostConfig[] {
  return readAll().map(toConfig)
}

export function getStoredHost(id: string): StoredHost | undefined {
  return readAll().find((h) => h.id === id)
}

export function saveHost(input: HostInput): HostConfig {
  const hosts = readAll()
  const existing = input.id ? hosts.find((h) => h.id === input.id) : undefined

  let encryptedPassword = existing?.encryptedPassword
  if (input.password !== undefined) {
    encryptedPassword = input.password ? encryptPassword(input.password) : undefined
  }

  const record: StoredHost = {
    id: existing?.id ?? randomUUID(),
    name: input.name,
    url: input.url,
    user: input.user,
    catalog: input.catalog || undefined,
    schema: input.schema || undefined,
    insecure: input.insecure || undefined,
    encryptedPassword
  }

  const next = existing
    ? hosts.map((h) => (h.id === record.id ? record : h))
    : [...hosts, record]
  writeAll(next)
  return toConfig(record)
}

export function deleteHost(id: string): void {
  writeAll(readAll().filter((h) => h.id !== id))
}
