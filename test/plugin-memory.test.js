import test from 'node:test'
import assert from 'node:assert/strict'
import { assessPlugins, growthSlope, normalizePluginConfig, PluginMemory } from '../lib/plugin-memory.js'
import { makeTempDir } from './helpers.js'

const MIB = 1024 * 1024

function windowAt(at, packages, options = {}) {
  const total = options.totalBytes ?? packages.reduce((sum, entry) => sum + entry.bytes, 0)
  return {
    at,
    reason: 'manual',
    durationMs: 1000,
    totalBytes: total,
    nativeBytes: 0,
    attributedBytes: total,
    packages: packages.map((entry) => ({ kind: 'npm', nodes: 1, top: [], ...entry })),
    radar: options.radar ?? {},
  }
}

test('normalizePluginConfig applies defaults and clamps out-of-range values', () => {
  assert.deepEqual(normalizePluginConfig({}), { enabled: true, sampling: true, sampleMinutes: 15, sampleSeconds: 20, leakMb: 32 })
  assert.deepEqual(normalizePluginConfig({ pluginMemory: false, pluginSampling: false, pluginSampleMinutes: 1000, pluginSampleSeconds: 1, pluginLeakMb: 2 }), {
    enabled: false,
    sampling: false,
    sampleMinutes: 120,
    sampleSeconds: 5,
    leakMb: 8,
  })
  assert.equal(normalizePluginConfig({ pluginSampleMinutes: Number.NaN }).sampleMinutes, 15)
})

test('growthSlope fits a straight line per hour', () => {
  const t0 = 1_700_000_000_000
  const slope = growthSlope([
    { at: t0, bytes: 10 * MIB },
    { at: t0 + 3_600_000, bytes: 20 * MIB },
    { at: t0 + 7_200_000, bytes: 30 * MIB },
  ])
  assert.equal(Math.round(slope), 10 * MIB)
  assert.equal(growthSlope([{ at: t0, bytes: 1 }]), null)
  assert.equal(growthSlope([{ at: t0, bytes: 1 }, { at: t0, bytes: 2 }]), null)
})

test('assessPlugins flags byte growth, handle growth and exclusions', () => {
  const t0 = 1_700_000_000_000
  const windows = [
    windowAt(t0, [
      { key: 'dsh-ops', name: 'dsh-ops', bytes: 5 * MIB },
      { key: 'dsh-unlag', name: 'dsh-unlag', bytes: 4 * MIB },
      { key: '(native)', name: '(native)', bytes: 900 * MIB },
      { key: 'dsh', name: 'dsh', bytes: 200 * MIB },
    ]),
    windowAt(t0 + 20 * 60_000, [
      { key: 'dsh-ops', name: 'dsh-ops', bytes: 25 * MIB },
      { key: 'dsh-unlag', name: 'dsh-unlag', bytes: 4 * MIB },
      { key: '(native)', name: '(native)', bytes: 900 * MIB },
      { key: 'dsh', name: 'dsh', bytes: 200 * MIB },
    ]),
  ]
  const radar = {
    enabled: true,
    totals: { timers: 3, listeners: 4 },
    packages: [
      { key: 'dsh-ops', name: 'dsh-ops', kind: 'npm', timers: 2, listeners: 9, timerPeak: 2, listenerPeak: 9 },
      { key: 'dsh-unlag', name: 'dsh-unlag', kind: 'npm', timers: 1, listeners: 1, timerPeak: 1, listenerPeak: 1 },
    ],
  }
  const handlesWindows = [
    windowAt(t0, [{ key: 'dsh-unlag', name: 'dsh-unlag', bytes: 4 * MIB }], { radar: { 'dsh-unlag': { timers: 1, listeners: 1 } } }),
    windowAt(t0 + 20 * 60_000, [{ key: 'dsh-unlag', name: 'dsh-unlag', bytes: 4 * MIB }], { radar: { 'dsh-unlag': { timers: 6, listeners: 1 } } }),
  ]
  const result = assessPlugins({ windows, radar, leakMb: 32, ownPackage: null })
  const keys = result.map((entry) => entry.key)
  assert.deepEqual(keys.sort(), ['dsh-ops', 'dsh-unlag'])
  const ops = result.find((entry) => entry.key === 'dsh-ops')
  assert.equal(ops.level, 'high')
  assert.equal(Math.round(ops.growthBytesPerHour / MIB), 60)
  assert.ok(ops.reasons.includes('bytes-growth'))
  const unlag = result.find((entry) => entry.key === 'dsh-unlag')
  assert.equal(unlag.level, 'low')

  const withHandles = assessPlugins({ windows: handlesWindows, radar, leakMb: 32 })
  const handleOps = withHandles.find((entry) => entry.key === 'dsh-unlag')
  assert.equal(handleOps.level, 'medium')
  assert.ok(handleOps.reasons.includes('handle-growth'))

  const owned = assessPlugins({ windows, radar, leakMb: 32, ownPackage: 'dsh-ops' })
  assert.equal(owned.find((entry) => entry.key === 'dsh-ops'), undefined)
})

test('PluginMemory persists windows and exposes a status snapshot', async () => {
  const dir = await makeTempDir()
  try {
    const clock = { now: 1_700_000_000_000 }
    const memory = new PluginMemory({ dir: dir.dir, config: { pluginMemory: true, pluginSampling: false }, now: () => clock.now, ownPackage: 'dsh-memory-watchdog' })
    assert.equal(await memory.load(), false)
    memory.windows = [
      windowAt(clock.now, [{ key: 'dsh-ops', name: 'dsh-ops', bytes: 6 * MIB }]),
      windowAt(clock.now + 20 * 60_000, [{ key: 'dsh-ops', name: 'dsh-ops', bytes: 30 * MIB }]),
    ]
    memory.lastWindow = memory.windows.at(-1)
    memory.lastSampleAt = memory.lastWindow.at
    await memory.persist()

    const reopened = new PluginMemory({ dir: dir.dir, config: { pluginSampling: false }, ownPackage: 'dsh-memory-watchdog' })
    assert.equal(await reopened.load(), true)
    assert.equal(reopened.windows.length, 2)
    assert.equal(reopened.windows[1].totalBytes, 30 * MIB)

    const status = reopened.status()
    assert.equal(status.enabled, true)
    assert.equal(status.sampling.enabled, false)
    assert.equal(status.totals.windows, 2)
    assert.equal(status.packages[0].key, 'dsh-ops')
    assert.equal(status.packages[0].level, 'high')
    assert.equal(status.totals.spanMs, 20 * 60_000)
    assert.equal(typeof status.totals.rss, 'number')
  } finally {
    await dir.cleanup()
  }
})

test('installed plugins are listed before any heap window exists', () => {
  const inventory = [
    { key: 'dsh-ops', name: 'dsh-ops', kind: 'plugin', version: '0.4.4' },
    { key: 'dsh-unlag', name: 'dsh-unlag', kind: 'plugin', version: '1.14.15' },
  ]
  const rows = assessPlugins({ windows: [], radar: null, inventory, leakMb: 32, ownPackage: 'dsh-memory-watchdog' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].key, 'dsh-ops')
  assert.equal(rows[0].installed, true)
  assert.equal(rows[0].version, '0.4.4')
  assert.equal(rows[0].samples, 0)
  assert.equal(rows[0].level, 'unknown')
  assert.equal(rows[0].bytes, 0)
})

test('radar-only rows for framework packages are dropped once an inventory exists', () => {
  const inventory = [{ key: 'dsh-ops', name: 'dsh-ops', kind: 'plugin', version: '0.4.4' }]
  const radar = {
    packages: [
      { key: 'dsh-ops', timers: 2, listeners: 3 },
      { key: 'cordis', timers: 9, listeners: 40 },
      { key: '(local)', timers: 1, listeners: 1 },
    ],
  }
  const rows = assessPlugins({ windows: [], radar, inventory, leakMb: 32, ownPackage: 'dsh-memory-watchdog' })
  assert.deepEqual(rows.map((row) => row.key), ['dsh-ops'])
  assert.equal(rows[0].timers, 2)
  assert.equal(rows[0].listeners, 3)
})

test('watchReloads records what a plugin kept across an unload', async () => {
  const dir = await makeTempDir()
  try {
    let clock = 1_000
    const memory = new PluginMemory({ dir: dir.dir, config: { pluginMemory: false }, now: () => clock })
    const packages = [{ key: 'dsh-ops', name: 'dsh-ops', timers: 1, listeners: 1 }]
    memory.radar = { installed: true, uninstall() {}, snapshot: () => ({ packages }) }
    memory.ledger = { 'dsh-ops': { name: 'dsh-ops', lastBytes: 40 * MIB } }

    memory.watchReloads()
    assert.equal(memory.openReloads.size, 0)

    packages[0].timers = 0
    packages[0].listeners = 0
    clock = 2_000
    memory.watchReloads()
    assert.equal(memory.openReloads.size, 1)
    assert.equal(memory.openReloads.get('dsh-ops').beforeBytes, 40 * MIB)

    packages[0].timers = 1
    memory.ledger['dsh-ops'].lastBytes = 48 * MIB
    clock = 3_000
    memory.watchReloads()
    assert.equal(memory.openReloads.size, 0)
    assert.equal(memory.reloads.length, 1)
    assert.equal(memory.reloads[0].retainedBytes, 8 * MIB)
    assert.equal(memory.reloads[0].gapMs, 1_000)

    const status = memory.status()
    assert.equal(status.reloads.length, 1)
    assert.equal(status.reloads[0].key, 'dsh-ops')
    await memory.stop()
  } finally {
    await dir.cleanup()
  }
})

test('disabled PluginMemory refuses to sample', async () => {
  const dir = await makeTempDir()
  try {
    const memory = new PluginMemory({ dir: dir.dir, config: { pluginMemory: false } })
    const result = await memory.sampleNow()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'plugin-memory-disabled')
    await memory.stop()
  } finally {
    await dir.cleanup()
  }
})