import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPagefileAdvice, normalizeSystemInfo, sampleSystemInfo } from '../lib/system-info.js'
import { GIB } from './helpers.js'

const MIB = 1024 * 1024

function raw(overrides = {}) {
  return {
    ok: true,
    ts: 1000,
    systemDrive: 'C:',
    automaticManaged: false,
    commitUsed: 20 * GIB,
    commitLimit: 48 * GIB,
    physicalTotal: 32 * GIB,
    physicalAvailable: 10 * GIB,
    pagefileTotalBytes: 16 * GIB,
    pagefiles: [
      { path: 'D:\\pagefile.sys', initialMb: 16384, maximumMb: 16384, currentMb: 16384, exists: true, systemVolume: false },
    ],
    ...overrides,
  }
}

test('system info normalizes pagefiles and reports healthy headroom', () => {
  const result = normalizeSystemInfo(raw(), { at: 5000 })
  assert.equal(result.ok, true)
  assert.equal(result.at, 5000)
  assert.equal(result.pagefileTotalBytes, 16 * GIB)
  assert.equal(result.usedPct, 41.7)
  assert.equal(result.pagefiles.length, 1)
  assert.equal(result.pagefiles[0].currentMb, 16384)
  assert.deepEqual(result.advice.map((entry) => entry.code), ['pagefile.ok'])
})

test('a missing pagefile produces a warning with a suggested size', () => {
  const result = normalizeSystemInfo(raw({ pagefileTotalBytes: 0, pagefiles: [] }), { at: 1 })
  assert.equal(result.advice[0].code, 'pagefile.none')
  assert.equal(result.advice[0].severity, 'warn')
  assert.equal(result.advice[0].suggestionMb, 8192)
})

test('small headroom relative to RAM is flagged', () => {
  const result = normalizeSystemInfo(
    raw({ commitLimit: 33 * GIB, pagefileTotalBytes: 1 * GIB, pagefiles: [{ path: 'C:\\pagefile.sys', currentMb: 1024, exists: true, systemVolume: true }] }),
    { at: 1 },
  )
  assert.equal(result.advice[0].code, 'pagefile.small')
  assert.equal(result.advice[0].headroomMb, 1024)
})

test('a system-volume-only pagefile on a large machine is noted but not alarmed', () => {
  const advice = buildPagefileAdvice({
    physicalTotal: 32 * GIB,
    commitLimit: 64 * GIB,
    pagefileTotalBytes: 32 * GIB,
    pagefiles: [{ systemVolume: true }, { systemVolume: true }],
  })
  assert.deepEqual(advice.map((entry) => entry.code), ['pagefile.system-volume'])
  assert.equal(advice[0].severity, 'info')
})

test('automatic management is reported alongside the verdict', () => {
  const result = normalizeSystemInfo(raw({ automaticManaged: true }), { at: 1 })
  assert.equal(result.automaticManaged, true)
  assert.deepEqual(result.advice.map((entry) => entry.code), ['pagefile.ok', 'pagefile.automatic'])
})

test('sampleSystemInfo normalizes the probe payload and failures', async () => {
  const ok = await sampleSystemInfo({
    scriptPath: 'x',
    now: () => 42,
    run: async (options) => {
      assert.deepEqual(options.args, [])
      return { ok: true, value: raw() }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.at, 42)
  assert.equal(ok.pagefileTotalBytes, 16 * GIB)

  const failed = await sampleSystemInfo({ scriptPath: 'x', now: () => 43, run: async () => ({ ok: false, error: 'nope' }) })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'nope')
  assert.deepEqual(failed.advice, [])
})

test('pagefile mb values are rounded to whole mebibytes', () => {
  const result = normalizeSystemInfo(raw({ pagefileTotalBytes: 1536 * MIB + 123 }), { at: 1 })
  assert.equal(result.pagefiles[0].currentMb, 16384)
  assert.equal(result.advice[0].pagefileMb, 1536)
})
