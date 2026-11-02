import test from 'node:test'
import assert from 'node:assert/strict'
import { createHeapWatch, classifyCrashTrail } from '../lib/heap-watch.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const MINUTE = 60 * 1000

function heapSample(at, pct, { heapTotal = 100 * MIB, external = 10 * MIB, arrayBuffers = 0, rss = 200 * MIB } = {}) {
  return { at, pct, rss, heapUsed: (pct / 100) * heapTotal, heapTotal, external, arrayBuffers }
}

test('near-limit needs consecutive samples and recovers below the lower threshold', () => {
  let clock = 1_000_000
  const watch = createHeapWatch({ now: () => clock, markMs: MINUTE })
  watch.record(heapSample(clock, 92))
  clock += 4000
  watch.record(heapSample(clock, 93))
  assert.equal(watch.status(clock).nearLimit, false, 'two samples are not enough')
  clock += 4000
  watch.record(heapSample(clock, 94))
  assert.equal(watch.status(clock).nearLimit, true)
  assert.equal(watch.status(clock).ratioPct, 94)

  clock += 4000
  watch.record(heapSample(clock, 88))
  assert.equal(watch.status(clock).nearLimit, true, 'between the two thresholds the alert holds')
  clock += 4000
  watch.record(heapSample(clock, 84))
  assert.equal(watch.status(clock).nearLimit, false)
})

test('external growth is a rate over a real span, not a single jump', () => {
  const start = 1_000_000
  const watch = createHeapWatch({ markMs: MINUTE, spanMs: 30 * MINUTE, rateWindowMs: 60 * MINUTE })
  watch.record(heapSample(start, 50, { external: 100 * MIB }))
  watch.record(heapSample(start + 10 * MINUTE, 50, { external: 160 * MIB }))
  const early = watch.status(start + 10 * MINUTE)
  assert.equal(early.externalRateMbPerHour, null, 'shorter than the minimum span')
  watch.record(heapSample(start + 30 * MINUTE, 50, { external: 300 * MIB }))
  const later = watch.status(start + 30 * MINUTE)
  assert.equal(later.externalRateMbPerHour, 400)
})

test('crash trails classify as heap, external or system exhaustion', () => {
  const heap = classifyCrashTrail({
    samples: [{ at: 1, pct: 60, rss: 2 * GIB, heapUsed: 980 * MIB, heapTotal: 1000 * MIB, external: 10 * MIB, arrayBuffers: 0 }],
  })
  assert.equal(heap.oomClass, 'oom-heap')
  assert.equal(heap.ratioPct, 98)

  const external = classifyCrashTrail({
    samples: [{ at: 1, pct: 60, rss: 2 * GIB, heapUsed: 100 * MIB, heapTotal: 500 * MIB, external: 1.2 * GIB, arrayBuffers: 100 * MIB }],
  })
  assert.equal(external.oomClass, 'oom-external')
  assert.equal(external.externalSharePct, 64.9)

  const system = classifyCrashTrail({
    samples: [{ at: 1, pct: 93, rss: 2 * GIB, heapUsed: 100 * MIB, heapTotal: 500 * MIB, external: 10 * MIB, arrayBuffers: 0 }],
  })
  assert.equal(system.oomClass, 'oom-system')
  assert.equal(system.commitPct, 93)

  const unknown = classifyCrashTrail({
    samples: [{ at: 1, pct: 40, rss: 2 * GIB, heapUsed: 100 * MIB, heapTotal: 500 * MIB, external: 10 * MIB, arrayBuffers: 0 }],
  })
  assert.equal(unknown.oomClass, null)
  assert.equal(classifyCrashTrail({ samples: [] }), null)
})