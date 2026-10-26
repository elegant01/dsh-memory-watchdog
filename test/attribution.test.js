import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attributionFresh,
  evaluateRestartGate,
  normalizeAttribution,
  sampleAttribution,
} from '../lib/attribution.js'
import { ATTRIBUTION_MAX_AGE_MS } from '../lib/constants.js'
import { GIB } from './helpers.js'

function raw(overrides = {}) {
  return {
    ok: true,
    ts: 1000,
    systemCommitUsed: 40 * GIB,
    systemCommitLimit: 64 * GIB,
    physicalTotal: 32 * GIB,
    physicalAvailable: 8 * GIB,
    scanned: 100,
    accessible: 80,
    dsh: { pids: [1, 2], count: 2, bytes: 10 * GIB, sharePct: 25 },
    top: [
      { pid: 9, parentPid: 1, name: 'small.exe', bytes: 1 * GIB, dsh: false },
      { pid: 2, parentPid: 1, name: 'big.exe', bytes: 8 * GIB, dsh: true },
    ],
    ...overrides,
  }
}

test('attribution normalizes a probe result and computes the DSH share itself', () => {
  const result = normalizeAttribution(raw(), { at: 5000, topN: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.at, 5000)
  assert.equal(result.systemCommitUsed, 40 * GIB)
  assert.equal(result.dshBytes, 10 * GIB)
  assert.equal(result.dshCount, 2)
  assert.equal(result.sharePct, 25)
  assert.deepEqual(result.top.map((entry) => entry.pid), [2, 9])
  assert.equal(result.top[0].dsh, true)
})

test('attribution caps the top list and tolerates malformed entries', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    pid: index + 1,
    parentPid: 1,
    name: 'x'.repeat(200),
    bytes: (10 - index) * GIB,
    dsh: false,
  }))
  const result = normalizeAttribution(raw({ top: many }), { at: 1, topN: 3 })
  assert.equal(result.top.length, 3)
  assert.deepEqual(result.top.map((entry) => entry.pid), [1, 2, 3])
  assert.ok(result.top[0].name.length <= 83)

  const junk = normalizeAttribution(raw({ top: [null, 'oops', { bytes: 5 }] }), { at: 1 })
  assert.deepEqual(junk.top, [])
})

test('attribution rejects a failed or empty probe', () => {
  const failed = normalizeAttribution({ ok: false, error: 'boom' }, { at: 9 })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'boom')
  assert.equal(failed.sharePct, null)
  assert.deepEqual(failed.top, [])
  assert.equal(normalizeAttribution(null, { at: 9 }).ok, false)
})

test('freshness expires after the documented maximum age', () => {
  const value = normalizeAttribution(raw(), { at: 1000 })
  assert.equal(attributionFresh(value, 1000 + ATTRIBUTION_MAX_AGE_MS), true)
  assert.equal(attributionFresh(value, 1001 + ATTRIBUTION_MAX_AGE_MS), false)
  assert.equal(attributionFresh(null, 1000), false)
  assert.equal(attributionFresh(normalizeAttribution({ ok: false }, { at: 1000 }), 1000), false)
})

test('the restart gate fails closed without fresh attribution', () => {
  const value = normalizeAttribution(raw(), { at: 1000 })
  const blocked = evaluateRestartGate({ attribution: null, gatePct: 20, now: 1000 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.code, 'gate.unavailable')
  assert.equal(evaluateRestartGate({ attribution: value, gatePct: 20, now: 1000 + ATTRIBUTION_MAX_AGE_MS + 1 }).code, 'gate.stale')
  assert.equal(evaluateRestartGate({ attribution: normalizeAttribution(raw({ dsh: { bytes: 4 * GIB } }), { at: 1000 }), gatePct: 20, now: 1000 }).code, 'gate.share-below')
  assert.equal(evaluateRestartGate({ attribution: value, gatePct: 20, now: 1000 }).code, 'gate.passed')
  assert.equal(evaluateRestartGate({ attribution: value, gatePct: 0, now: 900000 }).allowed, true)
  assert.equal(evaluateRestartGate({ attribution: null, gatePct: 0, now: 1 }).code, 'gate.disabled')
})

test('sampleAttribution normalizes the PowerShell payload and failures', async () => {
  const ok = await sampleAttribution({
    scriptPath: 'x',
    hostPid: 10,
    mainPid: 20,
    now: () => 777,
    run: async (options) => {
      assert.deepEqual(options.args, ['-HostPid', '10', '-MainPid', '20', '-TopN', '10'])
      return { ok: true, value: raw() }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.at, 777)
  assert.equal(ok.sharePct, 25)

  const failed = await sampleAttribution({
    scriptPath: 'x',
    hostPid: 10,
    now: () => 778,
    run: async () => ({ ok: false, error: 'no powershell' }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'no powershell')
})
