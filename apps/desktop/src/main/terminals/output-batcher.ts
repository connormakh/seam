/**
 * Coalesces many small writes into fewer, larger ones.
 *
 * A pty emits output in tiny chunks; forwarding each one over IPC costs more
 * than the data. Chunks are buffered and flushed after `delayMs`, or sooner
 * once `maxBytes` is reached.
 */
export class OutputBatcher {
  private chunks: string[] = []
  private size = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushFn: (data: string) => void,
    private readonly delayMs = 8,
    private readonly maxBytes = 256 * 1024
  ) {}

  push(chunk: string): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size >= this.maxBytes) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return
    const data = this.chunks.join('')
    this.chunks = []
    this.size = 0
    this.flushFn(data)
  }

  dispose(): void {
    this.flush()
  }
}
