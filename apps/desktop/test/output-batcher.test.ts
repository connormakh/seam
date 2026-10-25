import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputBatcher } from '../src/main/terminals/output-batcher'

describe('OutputBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces chunks within the delay into one flush', () => {
    const flushed: string[] = []
    const b = new OutputBatcher((d) => flushed.push(d), 8)
    b.push('a')
    b.push('b')
    b.push('c')
    expect(flushed).toEqual([])
    vi.advanceTimersByTime(8)
    expect(flushed).toEqual(['abc'])
  })

  it('flushes immediately once the size cap is hit', () => {
    const flushed: string[] = []
    const b = new OutputBatcher((d) => flushed.push(d), 8, 4)
    b.push('ab')
    b.push('cd')
    expect(flushed).toEqual(['abcd'])
    vi.advanceTimersByTime(8)
    expect(flushed).toEqual(['abcd'])
  })

  it('flushes what is pending on dispose', () => {
    const flushed: string[] = []
    const b = new OutputBatcher((d) => flushed.push(d))
    b.push('tail')
    b.dispose()
    expect(flushed).toEqual(['tail'])
  })
})
