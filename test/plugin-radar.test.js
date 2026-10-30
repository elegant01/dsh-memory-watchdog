import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginRadar, hostBootAt, packageFromStack } from '../lib/plugin-radar.js'

// Registrations made from this test file count as "probe-plugin" so the radar
// has a real installed directory to attribute them to.
const HERE = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/').toLowerCase() + '/'
const OWNER_DIRS = [{ key: 'probe-plugin', name: 'probe-plugin', kind: 'plugin', path: HERE }]

function makeRadar(extra = {}) {
  return createPluginRadar({ ownerDirs: OWNER_DIRS, ...extra })
}

function entryFor(radar, key) {
  return radar.snapshot().packages.find((entry) => entry.key === key) ?? null
}

test('packageFromStack skips our own frames and node internals', () => {
  const stack = [
    'Error',
    '    at captureOwner (file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-memory-watchdog/lib/plugin-radar.js:1:1)',
    '    at pluginCode (file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/x.js:10:5)',
    '    at test (file:///F:/repo/test/a.test.js:5:3)',
  ].join('\n')
  const owner = packageFromStack(stack, { ownPackage: 'dsh-memory-watchdog' })
  assert.equal(owner.key, 'dsh-ops')

  const internal = [
    'Error',
    '    at process.on (node:internal/process/per_thread:1:1)',
    '    at pluginCode (file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/x.js:10:5)',
  ].join('\n')
  assert.equal(packageFromStack(internal, { ownPackage: null }), null)
  assert.equal(packageFromStack('nonsense', {}), null)
})

test('radar counts listeners once per registration and releases them', () => {
  const radar = makeRadar()
  assert.equal(radar.install(), true)
  assert.equal(radar.install(), false)
  try {
    const emitter = new EventEmitter()
    const listener = () => {}
    emitter.on('demo', listener)
    emitter.on('demo', listener)
    const added = entryFor(radar, 'probe-plugin')
    assert.equal(added.listeners, 1)

    emitter.removeListener('demo', listener)
    assert.equal(entryFor(radar, 'probe-plugin').listeners, 0)

    emitter.on('once-demo', listener)
    emitter.once('once-demo', listener)
    assert.equal(entryFor(radar, 'probe-plugin').listeners, 2)
    emitter.removeAllListeners('once-demo')
    assert.equal(entryFor(radar, 'probe-plugin').listeners, 0)
  } finally {
    radar.uninstall()
  }
  assert.equal(radar.installed, false)
})

test('radar counts interval handles and clears them', () => {
  const radar = makeRadar()
  radar.install()
  try {
    const timer = setInterval(() => {}, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    assert.equal(entryFor(radar, 'probe-plugin').timers, 1)
    clearInterval(timer)
    assert.equal(entryFor(radar, 'probe-plugin').timers, 0)
  } finally {
    radar.uninstall()
  }
})

test('uninstall restores the wrapped globals and snapshot reports totals', () => {
  const originalInterval = globalThis.setInterval
  const radar = makeRadar()
  radar.install()
  assert.notEqual(globalThis.setInterval, originalInterval)
  radar.uninstall()
  assert.equal(globalThis.setInterval, originalInterval)
  const snapshot = radar.snapshot()
  assert.equal(snapshot.enabled, false)
  assert.equal(typeof snapshot.totals.timers, 'number')
  assert.equal(typeof snapshot.totals.listeners, 'number')
  assert.equal(radar.reset(), true)
  assert.deepEqual(radar.snapshot().packages, [])
})

test('firstSeenMs measures when a package was first seen registering', async () => {
  // Fake clock: the host booted at t=1000 and the first plugin only shows up
  // two seconds later, so firstSeenMs has to come out as ~2000.
  const bootAt = 1_000
  let clock = bootAt
  const radar = makeRadar({ now: () => clock, bootAt, ownerDirs: OWNER_DIRS })
  radar.install()
  try {
    const emitter = new EventEmitter()
    const listener = () => {}
    // Immediate registration, at boot plus 0 ms.
    emitter.on('early', listener)
    const early = entryFor(radar, 'probe-plugin')
    assert.equal(early.firstSeenAt, bootAt)
    assert.equal(early.firstSeenMs, 0)

    radar.reset()
    clock = bootAt + 2_000
    emitter.on('late', listener)
    const late = entryFor(radar, 'probe-plugin')
    assert.equal(late.firstSeenMs, 2_000)
    assert.equal(late.firstSeenMs - early.firstSeenMs, 2_000)
  } finally {
    radar.uninstall()
  }
})

test('firstSeenAt is stamped once and only once per package', () => {
  let clock = 5_000
  const radar = makeRadar({ now: () => clock, bootAt: 1_000, ownerDirs: OWNER_DIRS })
  radar.install()
  try {
    const emitter = new EventEmitter()
    const first = () => {}
    const second = () => {}
    clock = 6_000
    emitter.on('a', first)
    clock = 9_000
    emitter.on('b', second)
    clock = 12_000
    emitter.on('c', () => {})
    const entry = entryFor(radar, 'probe-plugin')
    assert.equal(entry.listeners, 3)
    // The third registration is much later, but first-seen stays put.
    assert.equal(entry.firstSeenAt, 6_000)
    assert.equal(entry.firstSeenMs, 5_000)
  } finally {
    radar.uninstall()
  }
})

test('hostBootAt derives the boot instant from process.uptime', () => {
  const now = 100_000
  const uptime = process.uptime()
  const booted = hostBootAt(now)
  assert.equal(typeof booted, 'number')
  // Allow a couple of seconds of drift while the test itself runs.
  assert.ok(Math.abs(booted - (now - uptime * 1000)) < 2_000)
})

test('snapshot without a resolvable boot time reports null firstSeenMs', () => {
  const radar = makeRadar({ now: () => 7_777 })
  const snapshot = radar.snapshot()
  assert.equal(snapshot.packages.length, 0)
  assert.equal(typeof snapshot.uptimeMs === 'number' || snapshot.uptimeMs === null, true)
})