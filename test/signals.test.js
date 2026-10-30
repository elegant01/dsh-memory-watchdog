import test from 'node:test'
import assert from 'node:assert/strict'
import { createSignals } from '../lib/signals.js'

test('signals count process warnings without intercepting them', () => {
  const signals = createSignals({ now: () => 1_000 })
  assert.equal(signals.installed(), false)
  assert.equal(signals.install(), true)
  assert.equal(signals.installed(), true)
  assert.equal(signals.install(), false, 'install is idempotent')

  process.emit('warning', Object.assign(new Error('watchdog test warning'), { name: 'WatchdogTestWarning' }))
  process.emit('warning', Object.assign(new Error('second watchdog warning'), { name: 'WatchdogTestWarning' }))
  process.emit('warning', Object.assign(new Error('other'), { name: 'DeprecationWarning' }))

  const snapshot = signals.snapshot()
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.warnings.total, 3)
  assert.equal(snapshot.warnings.byName[0].name, 'WatchdogTestWarning')
  assert.equal(snapshot.warnings.byName[0].count, 2)
  assert.equal(snapshot.warnings.recent.length, 3)
  assert.equal(signals.uninstall(), true)
  assert.equal(signals.installed(), false)
  assert.equal(signals.uninstall(), false)
})

test('signals count uncaught exceptions through the monitor hook', () => {
  const signals = createSignals({ now: () => 2_000 })
  const before = process.listenerCount('uncaughtExceptionMonitor')
  signals.install()
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before + 1)
  process.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException')
  const snapshot = signals.snapshot()
  assert.equal(snapshot.uncaught.total, 1)
  assert.equal(snapshot.uncaught.recent[0].message, 'Error: boom')
  assert.equal(snapshot.uncaught.recent[0].origin, 'uncaughtException')
  signals.uninstall()
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before)
})

test('signals snapshot exposes handle counts and loop delay shape', () => {
  const signals = createSignals({ now: () => 3_000 })
  signals.install()
  try {
    const snapshot = signals.snapshot()
    assert.equal(typeof snapshot.handles.total, 'number')
    assert.ok(Array.isArray(snapshot.handles.byType))
    assert.ok(Array.isArray(snapshot.handles.series))
    assert.equal(snapshot.handles.points, 1, 'install takes the first handle sample')
    assert.ok(snapshot.loop === null || typeof snapshot.loop.meanMs === 'number')
    signals.sample()
    const sampled = signals.snapshot()
    assert.equal(typeof sampled.handles.total, 'number')
    assert.equal(sampled.handles.points, 2)
    assert.equal(sampled.handles.total, process.getActiveResourcesInfo().length)
  } finally {
    signals.uninstall()
  }
})

test('uninstall restores the process listeners it added', () => {
  const signals = createSignals({ now: () => 4_000 })
  const warningBefore = process.listenerCount('warning')
  const monitorBefore = process.listenerCount('uncaughtExceptionMonitor')
  signals.install()
  assert.equal(process.listenerCount('warning'), warningBefore + 1)
  signals.uninstall()
  assert.equal(process.listenerCount('warning'), warningBefore)
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorBefore)
  signals.uninstall()
  assert.equal(process.listenerCount('warning'), warningBefore)
})