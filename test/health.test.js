import test from 'node:test'
import assert from 'node:assert/strict'
import { computeHealth, gradeOf, HEALTH_WEIGHTS } from '../lib/health.js'

const GIB = 1024 ** 3

function healthyStatus() {
  return {
    pressure: { state: 'normal', pct: 40, commitLimit: 48 * GIB, stale: false },
    trend: { buckets: [] },
    crashes: { ok: true, crashCount: 0 },
    plugins: { enabled: true, packages: [] },
    signals: { enabled: true, loop: { p99Ms: 5 } },
  }
}

test('the weights add up to 100 so the score can be read as a percentage', () => {
  const total = Object.values(HEALTH_WEIGHTS).reduce((sum, value) => sum + value, 0)
  assert.equal(total, 100)
})

test('a calm snapshot scores a full 100 and deducts nothing', () => {
  const health = computeHealth({ status: healthyStatus(), renderer: { available: true, usedBytes: 128 * 1024 * 1024 } })
  assert.equal(health.score, 100)
  assert.equal(health.grade, 'good')
  assert.deepEqual(health.penalties, [])
  assert.equal(health.components.length, 6)
})

test('missing probes are reported as unavailable instead of costing points', () => {
  const health = computeHealth({ status: {} })
  assert.equal(health.score, 100)
  for (const component of health.components) {
    assert.equal(component.available, false, component.key)
    assert.equal(component.penalty, 0, component.key)
  }
  assert.deepEqual(health.penalties, [])
})

test('pressure above the warning threshold starts deducting against its own weight', () => {
  const status = healthyStatus()
  status.pressure = { state: 'critical', pct: 100, commitLimit: 48 * GIB, stale: false }
  const health = computeHealth({ status })
  const pressure = health.components.find((entry) => entry.key === 'pressure')
  assert.equal(pressure.available, true)
  assert.equal(pressure.penalty, HEALTH_WEIGHTS.pressure)
  assert.equal(health.score, 100 - HEALTH_WEIGHTS.pressure)
})

test('a stale pressure sample is not scored at all', () => {
  const status = healthyStatus()
  status.pressure = { state: 'warning', pct: 95, commitLimit: 48 * GIB, stale: true }
  const health = computeHealth({ status })
  const pressure = health.components.find((entry) => entry.key === 'pressure')
  assert.equal(pressure.available, false)
  assert.equal(pressure.detail, 'stale')
  assert.equal(pressure.penalty, 0)
})

test('growth needs two usable buckets spanning at least half an hour', () => {
  const status = healthyStatus()
  const first = { at: 0, n: 10, avg: 40 }
  const later = { at: 60 * 60 * 1000, n: 10, avg: 45 }
  // A single bucket cannot describe a slope.
  let health = computeHealth({ status: { ...status, trend: { buckets: [later] } } })
  assert.equal(health.components.find((entry) => entry.key === 'growth').available, false)
  // Two buckets ten minutes apart is still too short a window.
  health = computeHealth({ status: { ...status, trend: { buckets: [first, { ...later, at: 10 * 60 * 1000 }] } } })
  assert.equal(health.components.find((entry) => entry.key === 'growth').available, false)
  // An hour apart is enough, and 5% of 48 GiB per hour is a real growth figure.
  health = computeHealth({ status: { ...status, trend: { buckets: [first, later] } } })
  const growth = health.components.find((entry) => entry.key === 'growth')
  assert.equal(growth.available, true)
  assert.ok(growth.value > 2000 && growth.value < 2500, String(growth.value))
  assert.ok(growth.penalty > 0)
})

test('a shrinking commit charge never counts as growth', () => {
  const status = healthyStatus()
  status.trend = {
    buckets: [
      { at: 0, n: 10, avg: 50 },
      { at: 60 * 60 * 1000, n: 10, avg: 42 },
    ],
  }
  const health = computeHealth({ status })
  assert.equal(health.components.find((entry) => entry.key === 'growth').penalty, 0)
})

test('one crash is tolerated and the third one maxes out the crash weight', () => {
  const status = healthyStatus()
  const pen = (count) =>
    computeHealth({ status: { ...status, crashes: { ok: true, crashCount: count } } }).components.find((entry) => entry.key === 'crashes')
  assert.equal(pen(0).penalty, 0)
  assert.equal(pen(1).penalty, 0)
  assert.ok(pen(2).penalty > 0 && pen(2).penalty < HEALTH_WEIGHTS.crashes)
  assert.equal(pen(4).penalty, HEALTH_WEIGHTS.crashes)
})

test('plugins with a disabled radar are unavailable rather than clean', () => {
  const status = healthyStatus()
  status.plugins = { enabled: false, packages: [] }
  const health = computeHealth({ status })
  const plugins = health.components.find((entry) => entry.key === 'plugins')
  assert.equal(plugins.available, false)
  assert.equal(plugins.detail, 'disabled')
})

test('three high plugins use up the plugin weight', () => {
  const status = healthyStatus()
  status.plugins = {
    enabled: true,
    packages: [{ level: 'high' }, { level: 'high' }, { level: 'high' }],
  }
  const health = computeHealth({ status })
  assert.equal(health.components.find((entry) => entry.key === 'plugins').penalty, HEALTH_WEIGHTS.plugins)
})

test('an event loop p99 at the bad threshold maxes out its weight', () => {
  const status = healthyStatus()
  status.signals = { enabled: true, loop: { p99Ms: 500 } }
  const health = computeHealth({ status })
  assert.equal(health.components.find((entry) => entry.key === 'loop').penalty, HEALTH_WEIGHTS.loop)
})

test('the renderer heap is only scored once the panel has reported', () => {
  const withoutReport = computeHealth({ status: healthyStatus(), renderer: { available: false, reason: 'not-reported' } })
  assert.equal(withoutReport.components.find((entry) => entry.key === 'renderer').available, false)
  const big = computeHealth({ status: healthyStatus(), renderer: { available: true, usedBytes: 2 * GIB } })
  const renderer = big.components.find((entry) => entry.key === 'renderer')
  assert.equal(renderer.available, true)
  assert.equal(renderer.penalty, HEALTH_WEIGHTS.renderer)
})

test('penalties are sorted worst-first and only list what actually cost points', () => {
  const status = healthyStatus()
  status.pressure = { state: 'critical', pct: 98, commitLimit: 48 * GIB, stale: false }
  status.crashes = { ok: true, crashCount: 2 }
  status.signals = { enabled: true, loop: { p99Ms: 300 } }
  const health = computeHealth({ status })
  assert.ok(health.penalties.length >= 2)
  for (let index = 1; index < health.penalties.length; index += 1) {
    assert.ok(health.penalties[index - 1].penalty >= health.penalties[index].penalty)
  }
  assert.ok(health.penalties.every((entry) => entry.penalty >= 0.5))
  assert.ok(health.score < 100)
  assert.equal(health.score, Math.max(0, Math.round(100 - health.components.reduce((sum, entry) => sum + entry.penalty, 0))))
})

test('the score never goes below zero no matter how many components are maxed', () => {
  const health = computeHealth({
    status: {
      pressure: { state: 'critical', pct: 100, commitLimit: 48 * GIB, stale: false },
      trend: { buckets: [{ at: 0, n: 1, avg: 10 }, { at: 2 * 60 * 60 * 1000, n: 1, avg: 90 }] },
      crashes: { ok: true, crashCount: 9 },
      plugins: { enabled: true, packages: [{ level: 'high' }, { level: 'high' }, { level: 'high' }] },
      signals: { enabled: true, loop: { p99Ms: 5000 } },
    },
    renderer: { available: true, usedBytes: 8 * GIB },
  })
  assert.equal(health.score, 0)
  assert.equal(health.grade, 'bad')
})

test('grades follow the documented boundaries', () => {
  assert.equal(gradeOf(100), 'good')
  assert.equal(gradeOf(90), 'good')
  assert.equal(gradeOf(89.9), 'fair')
  assert.equal(gradeOf(75), 'fair')
  assert.equal(gradeOf(74.9), 'poor')
  assert.equal(gradeOf(50), 'poor')
  assert.equal(gradeOf(49.9), 'bad')
  assert.equal(gradeOf(null), 'unknown')
})

test('thresholds come from the status config when not passed in', () => {
  const status = healthyStatus()
  status.config = { thresholds: { warningPct: 20 } }
  status.pressure = { state: 'warning', pct: 30, commitLimit: 48 * GIB, stale: false }
  const low = computeHealth({ status })
  const high = computeHealth({ status, thresholds: { warningPct: 90 } })
  assert.ok(low.components.find((entry) => entry.key === 'pressure').penalty > 0)
  assert.equal(high.components.find((entry) => entry.key === 'pressure').penalty, 0)
})
