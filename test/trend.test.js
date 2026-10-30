import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createTrend, dayStart, hourStart } from '../lib/trend.js'
import { TREND_DAYS, TREND_STATUS_BUCKETS } from '../lib/constants.js'
import { makeClock, makeTempDir } from './helpers.js'

const HOUR = 60 * 60 * 1000

test('hour and day buckets follow the local clock', () => {
  const at = new Date(2026, 9, 30, 14, 37, 12, 345).getTime()
  const hour = new Date(hourStart(at))
  assert.equal(hour.getMinutes(), 0)
  assert.equal(hour.getSeconds(), 0)
  assert.equal(hour.getMilliseconds(), 0)
  assert.equal(hour.getHours(), 14)
  assert.equal(hour.getDate(), 30)
  const day = new Date(dayStart(at))
  assert.equal(day.getHours(), 0)
  assert.equal(day.getDate(), 30)
  assert.equal(hourStart(at) - dayStart(at), 14 * HOUR)
})

test('trend aggregates samples into one local hour with p50 and p95', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 9, 5, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now })
    assert.equal(await trend.load(), 0)

    for (const pct of [10, 20, 30, 40, 50, 60, 70, 80, 90, 95]) trend.record({ pct, at: clock.now })
    clock.advance(HOUR)
    trend.record({ pct: 42, at: clock.now })
    await trend.flush(clock.now)

    const status = trend.status(clock.now)
    assert.equal(status.buckets.length, 2)
    const first = status.buckets[0]
    assert.equal(first.n, 10)
    assert.equal(first.max, 95)
    assert.equal(first.p50, 51)
    assert.equal(first.p95, 95)
    assert.equal(first.avg, 54.5)
    assert.equal(status.buckets[1].n, 1)
    assert.equal(status.sampleCount, 11)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('trend counts actions and warnings per hour', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 9, 0, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now })
    assert.equal(trend.recordEvent('pressure-warning', clock.now), true)
    assert.equal(trend.recordEvent('pressure-warning', clock.now), true)
    assert.equal(trend.recordEvent('restart-attempt', clock.now), true)
    assert.equal(trend.recordEvent('restart-failed', clock.now), true)
    assert.equal(trend.recordEvent('pressure-normal', clock.now), false, 'only actionable kinds are counted')
    trend.record({ pct: 88, at: clock.now })
    const bucket = trend.status(clock.now).buckets[0]
    assert.equal(bucket.warnings, 2)
    assert.equal(bucket.actions, 2)
    assert.equal(bucket.criticals, 0)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('trend prunes buckets older than the retention window', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 12, 0, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now, days: 3 })
    for (let index = 0; index < 5; index += 1) {
      trend.record({ pct: 40 + index, at: clock.now - index * 24 * HOUR })
    }
    await trend.flush(clock.now)
    const status = trend.status(clock.now)
    assert.equal(status.days, 3)
    assert.equal(status.daily.length, 3, 'keepDays includes today')
    assert.equal(status.buckets.length, 3)
    assert.equal(status.sampleCount, 3)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('trend survives a reload and keeps writing atomically', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 8, 0, 0).getTime())
    const first = createTrend({ dir: dir.dir, now: () => clock.now })
    first.record({ pct: 71, at: clock.now })
    first.record({ pct: 93, at: clock.now })
    await first.flush(clock.now)
    await first.dispose()

    const second = createTrend({ dir: dir.dir, now: () => clock.now })
    assert.equal(await second.load(), 1)
    const status = second.status(clock.now)
    assert.equal(status.buckets.length, 1)
    assert.equal(status.buckets[0].n, 2)
    assert.equal(status.buckets[0].max, 93)
    await second.dispose()

    const stored = JSON.parse(await readFile(second.path, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.days, TREND_DAYS)
    assert.equal(stored.buckets.length, 1)
  } finally {
    await dir.cleanup()
  }
})

test('a corrupt trend file degrades to an empty history', async () => {
  const dir = await makeTempDir()
  try {
    const trend = createTrend({ dir: dir.dir, now: () => 1_000 })
    await writeFile(trend.path, '{ not json', 'utf8')
    assert.equal(await trend.load(), 0)
    assert.equal(typeof trend.status(1_000).error, 'string')
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('a bucket whose histogram went missing is dropped instead of flattening the line', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 8, 0, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now })
    await writeFile(
      trend.path,
      JSON.stringify({
        version: 1,
        days: 14,
        updatedAt: clock.now,
        buckets: [
          { at: hourStart(clock.now), n: 5, sum: 350, max: 80, hist: [], actions: 0, warnings: 0, criticals: 0 },
          { at: hourStart(clock.now) + HOUR, n: 2, sum: 100, max: 55, hist: null, actions: 0, warnings: 0, criticals: 0 },
        ],
      }),
      'utf8'
    )
    assert.equal(await trend.load(), 2)
    const status = trend.status(clock.now)
    const kept = status.buckets.filter((bucket) => bucket.n > 0)
    assert.equal(kept.length, 0, 'buckets without a histogram cannot answer p50/p95 and must not read as zero')
    assert.equal(status.sampleCount, 0)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('the status payload caps the recent window while daily keeps the long history', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 12, 0, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now })
    const total = TREND_STATUS_BUCKETS + 40
    for (let index = 0; index < total; index += 1) {
      trend.record({ pct: 50, at: clock.now - index * HOUR })
    }
    const status = trend.status(clock.now)
    assert.equal(status.buckets.length, TREND_STATUS_BUCKETS)
    assert.ok(status.daily.length > 0)
    assert.equal(status.sampleCount, total)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('maybeFlush throttles writes to the refresh window', async () => {
  const dir = await makeTempDir()
  try {
    const clock = makeClock(new Date(2026, 9, 30, 12, 0, 0).getTime())
    const trend = createTrend({ dir: dir.dir, now: () => clock.now, refreshMs: 10 * 60 * 1000 })
    trend.record({ pct: 50, at: clock.now })
    assert.notEqual(trend.maybeFlush(clock.now), null, 'the first tick always writes')
    clock.advance(60 * 1000)
    assert.equal(trend.maybeFlush(clock.now), null, 'a second later must not rewrite the file')
    clock.advance(10 * 60 * 1000)
    assert.notEqual(trend.maybeFlush(clock.now), null)
    await trend.dispose()
  } finally {
    await dir.cleanup()
  }
})
