import test from 'node:test'
import assert from 'node:assert/strict'
import { redactId, redactText, redactValue } from '../lib/redact.js'

test('a Windows profile root is replaced with a tilde', () => {
  assert.equal(redactText('C:\\Users\\alice\\.dsh\\memory-watchdog\\trend.json'), '~\\.dsh\\memory-watchdog\\trend.json')
  assert.equal(redactText('D:/Users/bob/x'), '~/x')
  assert.equal(redactText('keep C:\\Windows\\System32'), 'keep C:\\Windows\\System32')
})

test('a POSIX home directory is replaced with a tilde', () => {
  assert.equal(redactText('/home/alice/.dsh/state.json'), '~/.dsh/state.json')
  assert.equal(redactText('/Users/alice/Library/x'), '~/Library/x')
  assert.equal(redactText('/usr/lib/node'), '/usr/lib/node')
})

test('several profile roots inside one string are all replaced', () => {
  assert.equal(
    redactText('C:\\Users\\alice\\a;C:\\Users\\alice\\b'),
    '~\\a;~\\b',
  )
})

test('a non-string survives text redaction untouched', () => {
  assert.equal(redactText(null), null)
  assert.equal(redactText(undefined), undefined)
  assert.equal(redactText(42), 42)
  assert.equal(redactText(''), '')
})

test('session ids are shortened but short ones are left alone', () => {
  assert.equal(redactId('0123456789abcdef'), '01234567...')
  assert.equal(redactId('short'), 'short')
  assert.equal(redactId('exactly8'), 'exactly8')
  assert.equal(redactId(null), null)
})

test('nested objects and arrays are redacted in place', () => {
  const input = {
    status: { paths: ['C:\\Users\\alice\\a', '/home/bob/b'], nested: { file: 'C:\\Users\\alice\\c' } },
    sessionId: '0123456789abcdef',
    counts: [1, 2, 3],
    flag: true,
    nothing: null,
  }
  const output = redactValue(input)
  assert.deepEqual(output.status.paths, ['~\\a', '~/b'])
  assert.equal(output.status.nested.file, '~\\c')
  assert.equal(output.sessionId, '01234567...')
  assert.deepEqual(output.counts, [1, 2, 3])
  assert.equal(output.flag, true)
  assert.equal(output.nothing, null)
  // The input must not be mutated: the same status object is served elsewhere.
  assert.equal(input.status.paths[0], 'C:\\Users\\alice\\a')
})

test('session id keys are matched case-insensitively', () => {
  const output = redactValue({ sessionID: '0123456789abcdef', ParentSessionId: 'fedcba9876543210' })
  assert.equal(output.sessionID, '01234567...')
  assert.equal(output.ParentSessionId, 'fedcba98...')
})

test('deep nesting collapses instead of recursing forever', () => {
  let value = 'C:\\Users\\alice\\leaf'
  for (let index = 0; index < 20; index += 1) value = { next: value }
  const output = redactValue(value)
  let depth = 0
  let cursor = output
  while (cursor !== null && typeof cursor === 'object' && cursor.next !== undefined) {
    cursor = cursor.next
    depth += 1
  }
  assert.ok(depth <= 9, `expected depth to be capped, walked ${depth}`)
  assert.equal(cursor, '[deep]')
})
