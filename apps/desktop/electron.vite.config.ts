import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { externalizeDeps: true }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { externalizeDeps: true }
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
    plugins: [react()]
  }
})
