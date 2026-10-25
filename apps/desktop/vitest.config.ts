import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests drive a real tmux server; give them room.
    testTimeout: 15_000
  }
})
