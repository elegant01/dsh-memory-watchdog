import { join } from 'node:path'
import {
  TREND_BIN_PCT,
  TREND_BINS,
  TREND_DAYS,
  TREND_FILE,
  TREND_REFRESH_MS,
  TREND_STATUS_BUCKETS,
} from './constants.js'
import { readJsonFile, writeJsonAtomic } from './util.js'

const DAY_MS = 24 * 60 * 60 * 1000

// Bucket edges follow the local clock, not UTC: a machine at UTC+05:30 must
// still see one bucket per local hour, otherwise the daily rollup would drift
// by half an hour every day.
export function hourStart(ms) {
  const date = new Date(ms)
  date.setMinutes(0, 0, 0)
  return date.getTime()
}

export function dayStart(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function binOf(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return -1
  const index = Math.floor(pct / TREND_BIN_PCT)
  if (!Number.isFinite(index)) return -1
  return Math.max(0, Math.min(TREND_BINS - 1, index))
}

// Quantiles come out of a fixed 2%-wide histogram, so a p95 is accurate to
// within one bin without ever keeping raw samples on disk. Precision is all a
// trend line needs; the exact number is still in the live pressure snapshot.
function quantile(hist, total, fraction) {
  if (!Number.isFinite(total) || total <= 0) return null
  const target = Math.max(1, Math.ceil(total * fraction))
  let seen = 0
  for (let index = 0; index < hist.length; index += 1) {
    seen += hist[index]
    if (seen >= target) return index * TREND_BIN_PCT + TREND_BIN_PCT / 2
  }
  return null
}

function emptyHist() {
  return new Array(TREND_BINS).fill(0)
}

function emptyBucket(at) {
  return {
    at,
    n: 0,
    sum: 0,
    max: null,
    hist: emptyHist(),
    actions: 0,
    warnings: 0,
    criticals: 0,
  }
}

function round1(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function readBucket(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
  const bucket = emptyBucket(value.at)
  bucket.n = Number.isFinite(value.n) ? Math.max(0, Math.round(value.n)) : 0
  bucket.sum = Number.isFinite(value.sum) ? value.sum : 0
  bucket.max = Number.isFinite(value.max) ? value.max : null
  bucket.actions = Number.isFinite(value.actions) ? Math.max(0, Math.round(value.actions)) : 0
  bucket.warnings = Number.isFinite(value.warnings) ? Math.max(0, Math.round(value.warnings)) : 0
  bucket.criticals = Number.isFinite(value.criticals) ? Math.max(0, Math.round(value.criticals)) : 0
  const hist = Array.isArray(value.hist) ? value.hist : []
  for (let index = 0; index < TREND_BINS; index += 1) {
    const count = hist[index]
    bucket.hist[index] = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0
  }
  // A bucket whose histogram was lost cannot answer p50/p95, and keeping it
  // would silently flatten the trend line to zero.
  const counted = bucket.hist.reduce((total, count) => total + count, 0)
  if (counted === 0 && bucket.n > 0) {
    bucket.n = 0
    bucket.sum = 0
    bucket.max = null
  }
  return bucket
}

export function createTrend({
  dir,
  now = Date.now,
  days = TREND_DAYS,
  refreshMs = TREND_REFRESH_MS,
} = {}) {
  const path = join(dir, TREND_FILE)
  const keepDays = Math.max(1, Math.round(days))
  const buckets = new Map()
  let lastWriteAt = 0
  let updatedAt = null
  let error = null
  let writeQueue = Promise.resolve()

  function prune(at) {
    const cutoff = dayStart(at) - (keepDays - 1) * DAY_MS
    let removed = 0
    for (const key of buckets.keys()) {
      if (key < cutoff) {
        buckets.delete(key)
        removed += 1
      }
    }
    return removed
  }

  async function load() {
    const result = await readJsonFile(path)
    if (!result.ok) {
      if (result.code !== 'ENOENT') error = typeof result.error === 'string' ? result.error : 'trend read failed'
      return 0
    }
    const value = result.value
    if (value === null || typeof value !== 'object') return 0
    const list = Array.isArray(value.buckets) ? value.buckets : []
    for (const entry of list) {
      const bucket = readBucket(entry)
      if (bucket !== null) buckets.set(bucket.at, bucket)
    }
    if (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) updatedAt = value.updatedAt
    prune(now())
    return buckets.size
  }

  function record({ pct, at = now() } = {}) {
    const bin = binOf(pct)
    if (bin < 0) return false
    const key = hourStart(at)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(key)
      buckets.set(key, bucket)
    }
    bucket.n += 1
    bucket.sum += pct
    bucket.hist[bin] += 1
    if (bucket.max === null || pct > bucket.max) bucket.max = pct
    return true
  }

  function recordEvent(kind, at = now()) {
    if (typeof kind !== 'string') return false
    const key = hourStart(at)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(key)
      buckets.set(key, bucket)
    }
    if (kind === 'pressure-warning') bucket.warnings += 1
    else if (kind === 'pressure-critical') bucket.criticals += 1
    else if (kind === 'restart-attempt' || kind === 'restart-handoff' || kind === 'restart-failed') bucket.actions += 1
    else return false
    return true
  }

  function bucketView(bucket) {
    const total = bucket.n
    return {
      at: bucket.at,
      n: total,
      p50: quantile(bucket.hist, total, 0.5),
      p95: quantile(bucket.hist, total, 0.95),
      max: round1(bucket.max),
      avg: total === 0 ? null : round1(bucket.sum / total),
      actions: bucket.actions,
      warnings: bucket.warnings,
      criticals: bucket.criticals,
    }
  }

  function dailyView(at) {
    const days = new Map()
    for (const bucket of buckets.values()) {
      const key = dayStart(bucket.at)
      let day = days.get(key)
      if (day === undefined) {
        day = { at: key, n: 0, sum: 0, max: null, p95: null, actions: 0, warnings: 0, criticals: 0 }
        days.set(key, day)
      }
      const view = bucketView(bucket)
      day.n += bucket.n
      day.sum += bucket.sum
      day.actions += bucket.actions
      day.warnings += bucket.warnings
      day.criticals += bucket.criticals
      if (view.max !== null && (day.max === null || view.max > day.max)) day.max = view.max
      if (view.p95 !== null && (day.p95 === null || view.p95 > day.p95)) day.p95 = view.p95
    }
    return [...days.values()]
      .sort((left, right) => left.at - right.at)
      .map((day) => ({
        at: day.at,
        n: day.n,
        max: round1(day.max),
        avg: day.n === 0 ? null : round1(day.sum / day.n),
        p95: day.p95,
        actions: day.actions,
        warnings: day.warnings,
        criticals: day.criticals,
      }))
      .filter((day) => day.at >= dayStart(at) - (keepDays - 1) * DAY_MS)
  }

  function payload(at) {
    const list = [...buckets.values()].sort((left, right) => left.at - right.at)
    return {
      version: 1,
      days: keepDays,
      updatedAt: at,
      buckets: list.map((bucket) => ({
        at: bucket.at,
        n: bucket.n,
        sum: bucket.sum,
        max: bucket.max,
        hist: bucket.hist,
        actions: bucket.actions,
        warnings: bucket.warnings,
        criticals: bucket.criticals,
      })),
    }
  }

  function flush(at = now()) {
    prune(at)
    const body = payload(at)
    updatedAt = body.updatedAt
    writeQueue = writeQueue
      .then(() => writeJsonAtomic(path, body))
      .catch((failure) => {
        error = failure instanceof Error ? failure.message : String(failure)
      })
    lastWriteAt = at
    return writeQueue
  }

  // Called from the one-second tick: writing every sample would rewrite the
  // whole file 720 times an hour, so the disk image trails reality by at most
  // one refresh window and a crash costs a few minutes of trend, not a file.
  function maybeFlush(at = now()) {
    if (lastWriteAt !== 0 && at - lastWriteAt < refreshMs) return null
    return flush(at)
  }

  function status(at = now()) {
    const cutoff = dayStart(at) - (keepDays - 1) * DAY_MS
    const visible = [...buckets.values()]
      .filter((bucket) => bucket.at >= cutoff)
      .sort((left, right) => left.at - right.at)
    // The wire payload carries a short recent window only: 14 days of hourly
    // buckets is 336 rows and no chart on the card can show that, while the
    // full history stays on disk for the daily rollup.
    const recent = visible.slice(Math.max(0, visible.length - TREND_STATUS_BUCKETS))
    return {
      ok: error === null,
      path,
      days: keepDays,
      refreshMs,
      updatedAt,
      ageMs: updatedAt === null ? null : Math.max(0, at - updatedAt),
      sampleCount: visible.reduce((total, bucket) => total + bucket.n, 0),
      buckets: recent.map(bucketView),
      daily: dailyView(at),
      error,
    }
  }

  async function dispose() {
    await flush().catch(() => {})
    await writeQueue.catch(() => {})
  }

  return { path, load, record, recordEvent, flush, maybeFlush, status, dispose }
}
