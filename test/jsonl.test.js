import test from 'node:test'
import assert from 'node:assert/strict'
import { BoundedLineReader, parseCollectorSample } from '../lib/jsonl.js'
import { GIB } from './helpers.js'

function readerHarness(options = {}) {
  const lines = []
  const errors = []
  const reader = new BoundedLineReader({
    ...options,
    onLine: (line) => lines.push(line),
    onError: (kind) => errors.push(kind),
  })
  return { reader, lines, errors }
}

test('splits chunks on newlines, strips CR and skips blank lines', () => {
  const h = readerHarness()
  h.reader.push('{"a":1}\n\n{"b":2}\r\n{"c":')
  h.reader.push('3}\n')
  assert.deepEqual(h.lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  assert.deepEqual(h.errors, [])
})

test('flushes the trailing line on end', () => {
  const h = readerHarness()
  h.reader.push('tail\r')
  h.reader.end()
  assert.deepEqual(h.lines, ['tail'])
})

test('drops oversized lines but keeps processing later lines', () => {
  const h = readerHarness({ maxLineBytes: 8 })
  h.reader.push('123456789\nok\n')
  assert.deepEqual(h.lines, ['ok'])
  assert.deepEqual(h.errors, ['line-too-long'])
})

test('oversized trailing data is dropped on end', () => {
  const h = readerHarness({ maxLineBytes: 4 })
  h.reader.push('12345')
  h.reader.end()
  assert.deepEqual(h.lines, [])
})

test('buffer overflow discards input until the next newline', () => {
  const h = readerHarness({ maxBufferBytes: 10 })
  h.reader.push('0123456789AB')
  assert.deepEqual(h.errors, ['buffer-overflow'])
  h.reader.push('CDEF')
  h.reader.push('GH\nrecovered\n')
  assert.deepEqual(h.lines, ['recovered'])
})

test('ignores non-string chunks', () => {
  const h = readerHarness()
  h.reader.push(null)
  h.reader.push(Buffer.from('{"a":1}\n'))
  h.reader.push('')
  assert.deepEqual(h.lines, [])
})

test('parses a valid sample', () => {
  const limit = 16 * GIB
  const parsed = parseCollectorSample(
    JSON.stringify({
      ok: true,
      ts: 1234,
      commitUsed: 8 * GIB,
      commitLimit: limit,
      physicalTotal: 32 * GIB,
      physicalAvailable: 12 * GIB,
    }),
    999,
  )
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.sample.ts, 1234)
  assert.equal(parsed.sample.commitUsed, 8 * GIB)
})

test('falls back to now when the timestamp is missing or invalid', () => {
  const line = JSON.stringify({
    ok: true,
    ts: 'yesterday',
    commitUsed: 1,
    commitLimit: 100,
    physicalTotal: 100,
    physicalAvailable: 50,
  })
  assert.equal(parseCollectorSample(line, 424242).sample.ts, 424242)
})

test('rejects malformed JSON, non-objects and arrays', () => {
  assert.deepEqual(parseCollectorSample('not json'), { error: 'malformed-json' })
  assert.deepEqual(parseCollectorSample('null'), { error: 'malformed-object' })
  assert.deepEqual(parseCollectorSample('[1,2]'), { error: 'malformed-object' })
  assert.deepEqual(parseCollectorSample('"text"'), { error: 'malformed-object' })
})

test('surfaces collector errors and rejects invalid samples', () => {
  assert.deepEqual(parseCollectorSample(JSON.stringify({ ok: false, error: 'no perf counter' })), {
    error: 'collector-error: no perf counter',
  })
  assert.match(parseCollectorSample(JSON.stringify({ ok: false })).error, /^collector-error: unspecified/)

  const invalid = parseCollectorSample(
    JSON.stringify({
      ok: true,
      commitUsed: 200,
      commitLimit: 100,
      physicalTotal: 100,
      physicalAvailable: 50,
    }),
  )
  assert.deepEqual(invalid, { error: 'invalid-sample' })

  const missing = parseCollectorSample(JSON.stringify({ ok: true }))
  assert.deepEqual(missing, { error: 'invalid-sample' })
})
