import test from 'node:test'
import assert from 'node:assert/strict'
import { findOrphan, guardOrphanTarget, normalizeOrphanScan, orphanKillStatus, orphanScanStale } from '../lib/orphans.js'

const GIB = 1024 ** 3
const NOW = 1_700_000_000_000

function scan(at = NOW, items = []) {
  return {
    ok: true,
    at,
    rootPath: 'E:\\DeepSeek Harness',
    hostStartedAt: at - 60000,
    scanned: 300,
    items,
  }
}

function item(overrides = {}) {
  return {
    pid: 8123,
    parentPid: 8000,
    name: 'DeepSeek Harness.exe',
    bytes: 2 * GIB,
    ageMin: 120,
    exePath: 'E:\\DeepSeek Harness\\DeepSeek Harness.exe',
    createdAt: '133000000000000000',
    startedAt: NOW - 7200000,
    ...overrides,
  }
}

test('normalization keeps only items with an exact identity and sorts by bytes', () => {
  const value = normalizeOrphanScan({
    ok: true,
    rootPath: 'E:\\DeepSeek Harness',
    items: [
      item({ pid: 10, bytes: GIB }),
      item({ pid: 11, bytes: 3 * GIB }),
      item({ pid: 12, exePath: null }),
      item({ pid: 13, createdAt: null }),
      item({ pid: 4, bytes: 9 * GIB }),
      null,
    ],
  }, { at: NOW })
  assert.equal(value.ok, true)
  assert.deepEqual(value.items.map((entry) => entry.pid), [11, 10])
  assert.equal(value.items[0].createdAt, '133000000000000000')
  assert.equal(normalizeOrphanScan({ ok: false, error: 'boom' }, { at: NOW }).ok, false)
})

test('findOrphan only trusts a fresh scan and a listed pid', () => {
  const value = scan(NOW, [item()])
  assert.equal(findOrphan(value, 8123, NOW).ok, true)
  assert.equal(findOrphan(value, 3, NOW).code, 'invalid-pid')
  assert.equal(findOrphan(value, 9999, NOW).code, 'unknown-orphan')
  assert.equal(findOrphan(scan(NOW - 11 * 60 * 1000, [item()]), 8123, NOW).code, 'stale-orphans')
  assert.equal(findOrphan(null, 8123, NOW).code, 'no-orphans')
  assert.equal(orphanScanStale(scan(NOW), NOW), false)
  assert.equal(orphanScanStale(scan(NOW - 11 * 60 * 1000), NOW), true)
})

test('guards refuse protected names, the host and targets without an exact identity', () => {
  assert.equal(guardOrphanTarget({ ok: true, pid: 8123, name: 'explorer.exe', exePath: 'x', createdAt: '1' }).code, 'protected-process')
  assert.equal(guardOrphanTarget({ ok: true, pid: 4242, name: 'node.exe', exePath: 'x', createdAt: '1' }, { hostPid: 4242 }).code, 'protected-process')
  assert.equal(guardOrphanTarget({ ok: true, pid: 8123, name: 'node.exe', exePath: null, createdAt: '1' }).code, 'invalid-orphan')
  assert.equal(guardOrphanTarget({ ok: true, pid: 8123, name: 'node.exe', exePath: 'x', createdAt: null }).code, 'invalid-orphan')
  assert.equal(guardOrphanTarget({ ok: true, pid: 8123, name: 'node.exe', exePath: 'x', createdAt: '1' }).ok, true)
})

test('kill result codes map to HTTP statuses', () => {
  assert.equal(orphanKillStatus({ ok: true }), 200)
  assert.equal(orphanKillStatus({ ok: false, code: 'invalid-pid' }), 400)
  assert.equal(orphanKillStatus({ ok: false, code: 'protected-process' }), 403)
  assert.equal(orphanKillStatus({ ok: false, code: 'stale-orphans' }), 409)
  assert.equal(orphanKillStatus({ ok: false, code: 'kill-failed' }), 503)
})
