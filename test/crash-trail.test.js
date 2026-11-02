import test from 'node:test'
import assert from 'node:assert/strict'
import { attachCrashTrail } from '../lib/crash-history.js'

function previous(endAt, overrides = {}) {
  return {
    pid: 777,
    startAt: endAt - 3000,
    endAt,
    samples: [
      { at: endAt - 4000, pct: 82, rss: 500, heapUsed: 100, heapTotal: 200, state: 'normal' },
      { at: endAt, pct: 91, rss: 600, heapUsed: 190, heapTotal: 200, state: 'warning' },
    ],
    ...overrides,
  }
}

function crash(at, code = 'crash.main') {
  return { at, code, severity: 'critical', detail: 'exit 1' }
}

test('the nearest crash inside the window gets the blackbox trail', () => {
  const items = [crash(100_000), crash(40_000, 'system.resource-exhaustion')]
  const withTrail = attachCrashTrail(items, previous(98_000))
  assert.equal(withTrail[0].trail.pid, 777)
  assert.equal(withTrail[0].trail.endAt, 98_000)
  assert.equal(withTrail[0].trail.samples.length, 2)
  assert.equal(withTrail[0].trail.samples[1].heapTotal, 200)
  assert.equal(withTrail[1].trail, undefined)
  assert.equal(items[0].trail, undefined, 'input items are not mutated')
})

test('the crash closest to the last blackbox point wins', () => {
  const items = [crash(99_000), crash(97_500)]
  const withTrail = attachCrashTrail(items, previous(98_000))
  assert.equal(withTrail[0].trail, undefined)
  assert.equal(withTrail[1].trail.endAt, 98_000)
})

test('events outside the window or of another kind are left alone', () => {
  const far = [crash(100_000 - 3 * 60 * 1000)]
  assert.equal(attachCrashTrail(far, previous(100_000)), far)
  const unrelated = [{ at: 100_000, code: 'history.note' }]
  const result = attachCrashTrail(unrelated, previous(100_000))
  assert.equal(result[0].trail, undefined)
})

test('no previous run or an empty previous run changes nothing', () => {
  const items = [crash(100_000)]
  assert.equal(attachCrashTrail(items, null), items)
  assert.equal(attachCrashTrail(items, { endAt: 100_000, samples: [] }), items)
  assert.equal(attachCrashTrail([], previous(100_000)).length, 0)
})

test('trail points keep the fields the OOM classifier needs and drop junk', () => {
  const endAt = 100_000
  const withTrail = attachCrashTrail(
    [crash(endAt)],
    previous(endAt, {
      samples: [
        { at: endAt - 4000, pct: 90, heapUsed: 150, heapTotal: 200, external: 300, arrayBuffers: 50, rss: 900 },
        null,
        { at: endAt - 2000, pct: 93 },
      ],
    }),
  )
  const points = withTrail[0].trail.samples
  assert.equal(points.length, 2)
  assert.equal(points[0].external, 300)
  assert.equal(points[0].arrayBuffers, 50)
  assert.equal(points[1].heapTotal, null)
})