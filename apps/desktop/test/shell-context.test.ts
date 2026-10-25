import { describe, expect, it } from 'vitest'
import { formatShellContext, MASK, maskSecrets } from '../src/main/context/shell-context'
import type { CommandRecord } from '../src/main/shell/command-tracker'

const record = (o: Partial<CommandRecord> = {}): CommandRecord => ({
  id: 1,
  terminalId: 't-1',
  command: 'npm test -- auth',
  cwd: '/Users/connor/app',
  startedAt: 1_000,
  endedAt: 5_200,
  exitCode: 1,
  startLine: 10,
  endLine: 13,
  output: 'FAIL auth.spec.ts\n  expected 200, got 401\n1 failed',
  droppedLines: 0,
  ...o
})

const opts = { shellName: 'shell', homeDir: '/Users/connor' }

describe('formatShellContext', () => {
  it('wraps the command, where it ran, how it ended, and its output', () => {
    expect(formatShellContext(record(), opts).text).toBe(
      [
        '<shell-context shell="shell" cwd="~/app" exit="1" duration="4.2s">',
        '$ npm test -- auth',
        'FAIL auth.spec.ts',
        '  expected 200, got 401',
        '1 failed',
        '</shell-context>',
        ''
      ].join('\n')
    )
  })

  it('keeps the tail of long output and says where the rest is', () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
    const ctx = formatShellContext(record({ output }), { ...opts, maxLines: 200, fullOutputPath: '/tmp/seam-context/t-1-1.log' })
    expect(ctx.truncated).toBe(true)
    expect(ctx.lines).toBe(200)
    expect(ctx.text).toContain('line 301\n')
    expect(ctx.text).not.toContain('line 300\n')
    expect(ctx.text).toContain('[last 200 of 500 lines; full output: /tmp/seam-context/t-1-1.log]')
  })

  it('counts lines the tracker already dropped', () => {
    const ctx = formatShellContext(record({ output: 'a\nb', droppedLines: 98 }), opts)
    expect(ctx.text).toContain('[last 2 of 100 lines]')
  })

  it('respects the byte cap even with few, long lines', () => {
    const output = Array.from({ length: 20 }, () => 'x'.repeat(4000)).join('\n')
    const ctx = formatShellContext(record({ output }), { ...opts, maxBytes: 16 * 1024 })
    expect(Buffer.byteLength(ctx.text)).toBeLessThan(17 * 1024)
    expect(ctx.truncated).toBe(true)
  })

  it('says so when there was no output, or it could not be read', () => {
    expect(formatShellContext(record({ output: '' }), opts).text).toContain('[no output]')
    expect(formatShellContext(record({ output: null }), opts).text).toContain('[output not available')
  })

  it('escapes attribute values', () => {
    const ctx = formatShellContext(record({ cwd: '/tmp/a"b<c' }), opts)
    expect(ctx.text).toContain('cwd="/tmp/a&quot;b&lt;c"')
  })
})

describe('maskSecrets', () => {
  const cases: Array<[string, string]> = [
    ['export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz', `export ANTHROPIC_API_KEY=${MASK}`],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', `token ${MASK}`],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', `Authorization: Bearer ${MASK}`],
    ['aws key AKIAIOSFODNN7EXAMPLE here', `aws key ${MASK} here`],
    ['DB_PASSWORD="hunter2hunter2"', `DB_PASSWORD="${MASK}"`],
    ['postgres://app:s3cretpass@db.internal:5432/app', `postgres://app:${MASK}@db.internal:5432/app`],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', MASK]
  ]
  for (const [input, expected] of cases) {
    it(`masks ${input.slice(0, 32)}…`, () => {
      expect(maskSecrets(input).text).toBe(expected)
    })
  }

  it('leaves ordinary output alone', () => {
    const text = 'Tests 60 passed (60)\nDuration 3.6s\ntoken count: 12'
    expect(maskSecrets(text)).toEqual({ text, masked: 0 })
  })

  it('masks the command line too, and reports the count', () => {
    const ctx = formatShellContext(record({ command: 'curl -H "Authorization: Bearer abcdefghijkl" x', output: 'ok' }), opts)
    expect(ctx.text).toContain(`Bearer ${MASK}`)
    expect(ctx.masked).toBe(1)
    expect(ctx.text).toContain('[1 secret masked]')
  })
})
