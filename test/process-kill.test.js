import test from 'node:test'
import assert from 'node:assert/strict'
import { findKillTarget, guardKillTarget, killResultStatus, processBaseName } from '../lib/process-kill.js'
import { ATTRIBUTION_MAX_AGE_MS } from '../lib/constants.js'

const GIB = 1024 ** 3

function attribution(at, overrides = {}) {
  return {
    ok: true,
    at,
    top: [{ pid: 8123, name: 'chrome.exe', bytes: 4 * GIB, dsh: false }],
    groups: [
      {
        name: 'node.exe',
        dsh: true,
        dshBytes: 3 * GIB,
        members: [{ pid: 8124, bytes: 3 * GIB, dsh: true }],
      },
      {
        name: 'chrome.exe',
        dsh: false,
        dshBytes: 0,
        members: [{ pid: 8123, bytes: 4 * GIB, dsh: false }],
      },
    ],
    ...overrides,
  }
}

test('kill target lookup only trusts the latest attribution sample', () => {
  const now = 1_700_000_000_000
  assert.equal(findKillTarget(attribution(now), 0, now).code, 'invalid-pid')
  assert.equal(findKillTarget(attribution(now), 1234.5, now).code, 'invalid-pid')
  assert.equal(findKillTarget(attribution(now), 8123, now + ATTRIBUTION_MAX_AGE_MS + 1).code, 'stale-attribution')
  assert.equal(findKillTarget(attribution(now), 9999, now).code, 'unknown-pid')
  assert.equal(findKillTarget(null, 8123, now).code, 'no-attribution')

  const fromGroup = findKillTarget(attribution(now), 8123, now)
  assert.equal(fromGroup.ok, true)
  assert.equal(fromGroup.name, 'chrome.exe')
  assert.equal(fromGroup.bytes, 4 * GIB)

  const topOnly = findKillTarget(attribution(now, { groups: [] }), 8123, now)
  assert.equal(topOnly.ok, true)
  assert.equal(topOnly.name, 'chrome.exe')
})

test('guards refuse DSH, the host and critical Windows processes', () => {
  const now = 1_700_000_000_000
  const value = attribution(now)
  assert.equal(guardKillTarget(findKillTarget(value, 8124, now)).code, 'dsh-process')

  value.groups.push({ name: 'explorer.exe', dsh: false, members: [{ pid: 8125, bytes: GIB, dsh: false }] })
  assert.equal(guardKillTarget(findKillTarget(value, 8125, now)).code, 'protected-process')

  value.groups.push({ name: 'code.exe', dsh: false, members: [{ pid: 4242, bytes: GIB, dsh: false }] })
  assert.equal(guardKillTarget(findKillTarget(value, 4242, now), { hostPid: 4242 }).code, 'protected-process')

  const allowed = guardKillTarget(findKillTarget(value, 8123, now), { hostPid: 4242 })
  assert.equal(allowed.ok, true)
  assert.equal(processBaseName('Explorer.EXE'), 'explorer')
})

test('kill result codes map to HTTP statuses', () => {
  assert.equal(killResultStatus({ ok: true }), 200)
  assert.equal(killResultStatus({ ok: false, code: 'invalid-pid' }), 400)
  assert.equal(killResultStatus({ ok: false, code: 'dsh-process' }), 403)
  assert.equal(killResultStatus({ ok: false, code: 'protected-process' }), 403)
  assert.equal(killResultStatus({ ok: false, code: 'stale-attribution' }), 409)
  assert.equal(killResultStatus({ ok: false, code: 'unknown-pid' }), 409)
  assert.equal(killResultStatus({ ok: false, code: 'kill-failed' }), 503)
})
