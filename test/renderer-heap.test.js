import test from 'node:test'
import assert from 'node:assert/strict'
import { createRendererHeap } from '../lib/renderer-heap.js'
import { RENDERER_REPORT_MIN_INTERVAL_MS, RENDERER_SANITY_MAX_BYTES, RENDERER_STALE_MS } from '../lib/constants.js'

const GIB = 1024 ** 3

function clockAt(start = 1_700_000_000_000) {
  let now = start
  return { now: () => now, set: (value) => { now = value }, advance: (ms) => { now += ms } }
}

test('before any report the heap is unknown and says why', () => {
  const heap = createRendererHeap({ now: () => 1000 })
  const status = heap.status(1000)
  assert.equal(status.available, false)
  assert.equal(status.reason, 'not-reported')
  assert.equal(status.usedBytes, null)
  assert.equal(status.ageMs, null)
  assert.equal(status.stale, false)
})

test('an accepted report becomes the current reading', () => {
  const clock = clockAt()
  const heap = createRendererHeap({ now: clock.now })
  const result = heap.report({ usedBytes: 512 * 1024 * 1024, totalBytes: GIB, limitBytes: 2 * GIB })
  assert.deepEqual(result, { ok: true, accepted: true, reason: null })
  const status = heap.status(clock.now())
  assert.equal(status.available, true)
  assert.equal(status.usedBytes, 512 * 1024 * 1024)
  assert.equal(status.limitBytes, 2 * GIB)
  assert.equal(status.reportedAt, clock.now())
  assert.equal(status.stale, false)
  assert.equal(status.reason, null)
})

test('the reading goes stale but keeps the last figure instead of blanking it', () => {
  const clock = clockAt()
  const heap = createRendererHeap({ now: clock.now })
  heap.report({ usedBytes: 1024 })
  clock.advance(RENDERER_STALE_MS + 1)
  const status = heap.status(clock.now())
  assert.equal(status.stale, true)
  assert.equal(status.available, false, 'a stale figure must not look live')
  assert.equal(status.usedBytes, 1024, 'the number stays so the card does not jump to a dash')
  assert.equal(status.reason, 'stale')
  // Just inside the window it is still live.
  clock.set(status.reportedAt + RENDERER_STALE_MS)
  assert.equal(heap.status(clock.now()).available, true)
})

test('a page without performance.memory reports unsupported, not an error', () => {
  const clock = clockAt()
  const heap = createRendererHeap({ now: clock.now })
  const result = heap.report({ available: false })
  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.equal(result.reason, 'unsupported')
  const status = heap.status(clock.now())
  assert.equal(status.available, false)
  assert.equal(status.usedBytes, null)
  assert.equal(status.reason, 'unsupported', 'a browser without the API is a lasting state, not a stale number')
  assert.equal(status.stale, false)
})

test('a malformed body is rejected without wiping the last good reading', () => {
  const clock = clockAt()
  const heap = createRendererHeap({ now: clock.now })
  heap.report({ usedBytes: 2048 })
  for (const body of [null, 'text', 42, [], undefined]) {
    const result = heap.report(body)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-body')
  }
  assert.equal(heap.status(clock.now()).usedBytes, 2048)
})

test('absurd or negative byte counts are refused', () => {
  const heap = createRendererHeap({ now: () => 1000 })
  for (const usedBytes of [-1, NaN, Infinity, RENDERER_SANITY_MAX_BYTES + 1, 'lots']) {
    const result = heap.report({ usedBytes })
    assert.equal(result.ok, false, String(usedBytes))
    assert.equal(result.reason, 'invalid-used-bytes')
  }
  assert.equal(heap.status(1000).available, false)
})

test('a size that is only just inside the sanity ceiling is accepted', () => {
  const heap = createRendererHeap({ now: () => 1000 })
  assert.equal(heap.report({ usedBytes: RENDERER_SANITY_MAX_BYTES }).accepted, true)
})

test('reports inside the throttle window are acknowledged but not stored', () => {
  const clock = clockAt()
  const heap = createRendererHeap({ now: clock.now })
  heap.report({ usedBytes: 100 })
  clock.advance(1000)
  const throttled = heap.report({ usedBytes: 200 })
  assert.equal(throttled.ok, true)
  assert.equal(throttled.accepted, false)
  assert.equal(throttled.reason, 'throttled')
  assert.equal(throttled.retryInMs, RENDERER_REPORT_MIN_INTERVAL_MS - 1000)
  assert.equal(heap.status(clock.now()).usedBytes, 100, 'the throttled value never lands')
  clock.advance(RENDERER_REPORT_MIN_INTERVAL_MS)
  assert.equal(heap.report({ usedBytes: 200 }).accepted, true)
  assert.equal(heap.status(clock.now()).usedBytes, 200)
})

test('the very first report is not throttled', () => {
  const heap = createRendererHeap({ now: () => 1 })
  assert.equal(heap.report({ usedBytes: 1 }).accepted, true)
})

test('reset clears the reading so a disposed runtime leaves nothing behind', () => {
  const heap = createRendererHeap({ now: () => 1000 })
  heap.report({ usedBytes: 4096 })
  assert.equal(heap.status(1000).available, true)
  heap.reset()
  assert.equal(heap.status(1000).available, false)
  assert.equal(heap.status(1000).reason, 'not-reported')
  // After a reset a new report is not throttled by the old timestamp.
  assert.equal(heap.report({ usedBytes: 8192 }).accepted, true)
})

test('totalBytes is optional and never invents a limit', () => {
  const heap = createRendererHeap({ now: () => 1000 })
  heap.report({ usedBytes: 1024 })
  const status = heap.status(1000)
  assert.equal(status.usedBytes, 1024)
  assert.equal(status.totalBytes, null)
  assert.equal(status.limitBytes, null)
})

test('two runtimes keep separate readings', () => {
  const first = createRendererHeap({ now: () => 1000 })
  const second = createRendererHeap({ now: () => 1000 })
  first.report({ usedBytes: 111 })
  assert.equal(first.status(1000).usedBytes, 111)
  assert.equal(second.status(1000).available, false)
})
