import type { TrinoIdeApi } from '@shared/types'

declare global {
  interface Window {
    api: TrinoIdeApi
  }
}

export {}
