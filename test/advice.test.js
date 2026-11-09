import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAdvice } from '../lib/advice.js'
import { ADVICE_MAX_ITEMS } from '../lib/constants.js'

const GIB = 1024 ** 3

function calmStatus() {
  return {
    pressure: { state: 'normal', pct: 40 },
    autoRestart: { enabled: false },
    gate: { code: 'gate.passed', sharePct: 10, gatePct: 20 },
    system: { ok: true, advice: [] },
    crashes: { ok: true, crashCount: 0, days: 7, items: [] },
    plugins: { enabled: true, packages: [] },
    heap: { nearLimit: false, externalRateMbPerHour: 0 },
    signals: { enabled: true, loop: { p99Ms: 5 }, warnings: { total: 0, byName: {} } },
    residents: { alerts: [] },
  }
}

function keys(result) {
  return result.items.map((entry) => entry.key)
}

test('a calm system produces an empty list, not a wall of ok lines', () => {
  const result = buildAdvice({ status: calmStatus() })
  assert.deepEqual(result.items, [])
  assert.equal(result.total, 0)
  assert.equal(result.truncated, false)
  assert.equal(result.actionCount, 0)
})

test('every entry carries the five fields the card renders', () => {
  const status = calmStatus()
  status.pressure = { state: 'warning', pct: 84 }
  const result = buildAdvice({ status })
  assert.equal(result.items.length, 1)
  const entry = result.items[0]
  for (const field of ['key', 'severity', 'kind', 'source', 'why', 'how', 'text']) {
    assert.ok(field in entry, field)
  }
  assert.equal(entry.kind === 'advice' || entry.kind === 'action', true)
})

test('pressure becomes an action only when automatic restart is on', () => {
  const status = calmStatus()
  status.pressure = { state: 'warning', pct: 84 }
  const off = buildAdvice({ status })
  assert.equal(off.items[0].kind, 'advice')
  assert.equal(off.items[0].how, 'restart-disabled')
  const on = buildAdvice({ status: { ...status, autoRestart: { enabled: true } } })
  assert.equal(on.items[0].kind, 'action')
  assert.equal(on.items[0].how, 'restart-enabled')
  assert.equal(on.actionCount, 1)
})

test('the blocking gate codes are listed but the passing one is not', () => {
  const base = calmStatus()
  const withGate = (code) => buildAdvice({ status: { ...base, autoRestart: { enabled: true }, gate: { code, sharePct: 5, gatePct: 20 } } })
  assert.deepEqual(keys(withGate('gate.passed')), [])
  assert.deepEqual(keys(withGate('gate.disabled')), [])
  assert.deepEqual(keys(withGate('gate.share-below')), ['gate-share-below'])
  assert.deepEqual(keys(withGate('gate.unavailable')), ['gate-unavailable'])
  assert.deepEqual(keys(withGate('gate.stale')), ['gate-stale'])
  // With auto restart off the gate is moot, so it must not clutter the list.
  assert.deepEqual(keys(buildAdvice({ status: { ...base, gate: { code: 'gate.stale' } } })), [])
})

test('pagefile advice keeps every severity because this list is its only rendering', () => {
  const status = calmStatus()
  status.system = {
    ok: true,
    advice: [
      { code: 'pagefile.ok', severity: 'ok', suggestionMb: null, pagefileMb: 10000, headroomMb: 16384 },
      { code: 'pagefile.small', severity: 'warn', suggestionMb: 8192, pagefileMb: 1024, headroomMb: 512 },
    ],
  }
  const result = buildAdvice({ status })
  assert.deepEqual(keys(result).sort(), ['pagefile-ok', 'pagefile-small'])
  const small = result.items.find((entry) => entry.key === 'pagefile-small')
  assert.equal(small.severity, 'warn')
  assert.equal(small.code, 'pagefile.small')
  assert.equal(small.value.suggestionMb, 8192)
  const ok = result.items.find((entry) => entry.key === 'pagefile-ok')
  assert.equal(ok.severity, 'ok')
})

test('high plugins each get a line, capped at three, with a shared text key', () => {
  const status = calmStatus()
  status.plugins = {
    enabled: true,
    sampling: { leakMb: 32 },
    packages: [
      { key: 'a', name: 'plugin-a', level: 'high', bytes: 200 * 1024 * 1024, growthBytesPerHour: 40 * 1024 * 1024 },
      { key: 'b', name: 'plugin-b', level: 'high' },
      { key: 'c', name: 'plugin-c', level: 'high' },
      { key: 'd', name: 'plugin-d', level: 'high' },
      { key: 'e', name: 'plugin-e', level: 'medium' },
    ],
  }
  const result = buildAdvice({ status })
  assert.deepEqual(keys(result), ['plugin-a', 'plugin-b', 'plugin-c'])
  for (const entry of result.items) {
    assert.equal(entry.text, 'plugin-growth', 'a dynamic key cannot be a translation key')
    assert.equal(entry.how, 'plugin-reload')
  }
})

test('heap pressure shows up as its own two codes', () => {
  const status = calmStatus()
  status.heap = { nearLimit: true, ratioPct: 96, heapUsed: 1900, heapTotal: 2000, externalRateMbPerHour: 260, externalBytes: 3 * GIB }
  const result = buildAdvice({ status })
  assert.deepEqual(keys(result).sort(), ['heap-external-growth', 'heap-near-limit'])
})

test('crashes need the second one before they earn a line', () => {
  const base = calmStatus()
  const at = (count, items = []) => buildAdvice({ status: { ...base, crashes: { ok: true, crashCount: count, days: 7, items } } })
  assert.deepEqual(keys(at(1)), [])
  assert.deepEqual(keys(at(2)), ['crash-recent'])
  const withOom = at(3, [{ oom: { oomClass: 'oom-heap' } }])
  assert.equal(withOom.items[0].value.oomClass, 'oom-heap')
  // A failed probe is not evidence of health or of trouble.
  assert.deepEqual(keys(buildAdvice({ status: { ...base, crashes: { ok: false, error: 'timeout' } } })), [])
})

test('signals contribute loop latency and the noisiest warning source', () => {
  const status = calmStatus()
  status.signals = {
    enabled: true,
    loop: { p99Ms: 320 },
    warnings: { total: 9, byName: { DeprecationWarning: 2, MaxListenersExceededWarning: 7 } },
  }
  const result = buildAdvice({ status })
  assert.deepEqual(keys(result).sort(), ['loop-latency', 'process-warning'])
  const warning = result.items.find((entry) => entry.key === 'process-warning')
  assert.equal(warning.value.name, 'MaxListenersExceededWarning')
  assert.equal(warning.value.count, 7)
})

test('resident growth uses the first alert and says whether it was DSH', () => {
  const status = calmStatus()
  status.residents = {
    alerts: [{ pid: 10, name: 'node.exe', dsh: false, bytes: 5 * GIB, growthBytes: GIB, spanMs: 360000 }],
  }
  const result = buildAdvice({ status })
  assert.deepEqual(keys(result), ['resident-growth'])
  assert.equal(result.items[0].value.dsh, false)
  assert.equal(result.items[0].how, 'close-app')
})

test('a big renderer heap becomes advice, with the warning step above two GiB', () => {
  const status = calmStatus()
  assert.deepEqual(keys(buildAdvice({ status, renderer: { available: false, reason: 'not-reported' } })), [])
  const info = buildAdvice({ status, renderer: { available: true, usedBytes: 1.2 * GIB } })
  assert.equal(info.items[0].key, 'renderer-heap')
  assert.equal(info.items[0].severity, 'info')
  const warn = buildAdvice({ status, renderer: { available: true, usedBytes: 2.5 * GIB } })
  assert.equal(warn.items[0].severity, 'warn')
})

test('items are ordered by severity and then by key so the list is stable', () => {
  const status = calmStatus()
  status.pressure = { state: 'critical', pct: 96 }
  status.heap = { nearLimit: true, externalRateMbPerHour: 0 }
  status.system = { ok: true, advice: [{ code: 'pagefile.small', severity: 'warn' }] }
  const result = buildAdvice({ status })
  const ranks = { critical: 0, warn: 1, info: 2, ok: 3 }
  for (let index = 1; index < result.items.length; index += 1) {
    const previous = result.items[index - 1]
    const current = result.items[index]
    assert.ok(
      ranks[previous.severity] < ranks[current.severity] ||
        (ranks[previous.severity] === ranks[current.severity] && previous.key <= current.key),
      `${previous.key} before ${current.key}`,
    )
  }
})

test('duplicate keys collapse so one problem is never listed twice', () => {
  const status = calmStatus()
  // Two heap warnings that share nothing except the code that produces them.
  status.heap = { nearLimit: true, ratioPct: 96 }
  const result = buildAdvice({ status })
  assert.equal(new Set(keys(result)).size, keys(result).length)
})

test('the list is capped and says so instead of silently dropping entries', () => {
  const status = calmStatus()
  status.pressure = { state: 'warning', pct: 84 }
  status.heap = { nearLimit: true, externalRateMbPerHour: 300, externalBytes: 2 * GIB }
  status.crashes = { ok: true, crashCount: 4, days: 7, items: [] }
  status.signals = { enabled: true, loop: { p99Ms: 400 }, warnings: { total: 3, byName: { Warn: 3 } } }
  status.residents = { alerts: [{ name: 'x.exe', bytes: GIB, growthBytes: GIB, spanMs: 120000 }] }
  status.plugins = {
    enabled: true,
    packages: [{ key: 'a', level: 'high' }, { key: 'b', level: 'high' }, { key: 'c', level: 'high' }],
  }
  status.system = { ok: true, advice: [{ code: 'pagefile.small', severity: 'warn' }] }
  const result = buildAdvice({ status, renderer: { available: true, usedBytes: 3 * GIB } })
  assert.ok(result.total > ADVICE_MAX_ITEMS, String(result.total))
  assert.equal(result.items.length, ADVICE_MAX_ITEMS)
  assert.equal(result.truncated, true)
})

test('a null status degrades to an empty list instead of throwing', () => {
  const result = buildAdvice({})
  assert.deepEqual(result.items, [])
  assert.deepEqual(buildAdvice().items, [])
})
