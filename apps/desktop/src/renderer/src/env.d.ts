/// <reference types="vite/client" />
import type { SeamApi } from '@shared/ipc'

declare global {
  interface Window {
    seam: SeamApi
  }
}

export {}
