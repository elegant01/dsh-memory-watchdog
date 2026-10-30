import { join } from 'node:path'
import { BLACKBOX_FILE, BLACKBOX_MIN_GAP_MS, BLACKBOX_POINTS } from './constants.js'
import { readJsonFile, writeJsonAtomic } from './util.js'

/**
 * Ring buffer of the last minute of pressure samples, written to disk a few
 * seconds at a time so that a crash still leaves the trajectory behind. The
 * file is read back on the next start: if it belongs to another process, its
 * tail is the "last 60 seconds before the crash" the card shows.
 */
export function createBlackbox({ dir, now = Date.now, intervalMs = BLACKBOX_MIN_GAP_MS, points = BLACKBOX_POINTS } = {}) {
  const path = join(dir, BLACKBOX_FILE)
  const pid = process.pid
  const startAt = now()
  const samples = []
  let previous = null
  let lastAt = 0
  let lastEnd = null
  let writeQueue = Promise.resolve()
  let error = null

  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

  function readSample(value) {
    if (value === null || typeof value !== 'object') return null
    if (!isNumber(value.at)) return null
    return {
      at: value.at,
      pct: isNumber(value.pct) ? value.pct : null,
      used: isNumber(value.used) ? value.used : null,
      limit: isNumber(value.limit) ? value.limit : null,
      rss: isNumber(value.rss) ? value.rss : null,
      heapUsed: isNumber(value.heapUsed) ? value.heapUsed : null,
      state: typeof value.state === 'string' ? value.state : null,
    }
  }

  async function load() {
    const result = await readJsonFile(path)
    if (!result.ok) {
      error = typeof result.error === 'string' ? result.error : 'blackbox read failed'
      return null
    }
    if (result.value === null || typeof result.value !== 'object') return null
    // Same process id: this is our own file from a plugin reload, not a crash.
    if (result.value.pid === pid) return null
    const list = (Array.isArray(result.value.samples) ? result.value.samples : [])
      .map(readSample)
      .filter((entry) => entry !== null)
    if (list.length === 0) return null
    previous = {
      pid: isNumber(result.value.pid) ? result.value.pid : null,
      startAt: isNumber(result.value.startAt) ? result.value.startAt : null,
      endAt: isNumber(result.value.endAt) ? result.value.endAt : list[list.length - 1].at,
      samples: list,
    }
    return previous
  }

  function push(sample) {
    if (sample === null || typeof sample !== 'object') return false
    const at = isNumber(sample.at) ? sample.at : now()
    if (samples.length > 0 && at - lastAt < intervalMs) return false
    lastAt = at
    samples.push({
      at,
      pct: isNumber(sample.pct) ? sample.pct : null,
      used: isNumber(sample.used) ? sample.used : null,
      limit: isNumber(sample.limit) ? sample.limit : null,
      rss: isNumber(sample.rss) ? sample.rss : null,
      heapUsed: isNumber(sample.heapUsed) ? sample.heapUsed : null,
      state: typeof sample.state === 'string' ? sample.state : null,
    })
    if (samples.length > points) samples.splice(0, samples.length - points)
    lastEnd = at
    flush()
    return true
  }

  function flush() {
    if (samples.length === 0) return writeQueue
    const endAt = lastEnd ?? samples[samples.length - 1].at
    const payload = {
      version: 1,
      pid,
      startAt,
      endAt,
      samples: samples.slice(),
    }
    writeQueue = writeQueue
      .then(() => writeJsonAtomic(path, payload))
      .catch((failure) => {
        error = failure instanceof Error ? failure.message : String(failure)
      })
    return writeQueue
  }

  async function dispose() {
    await writeQueue.catch(() => {})
  }

  function status() {
    const first = samples.length > 0 ? samples[0].at : null
    return {
      path,
      pid,
      startAt,
      points: samples.length,
      spanMs: first === null ? 0 : (lastEnd ?? samples[samples.length - 1].at) - first,
      samples: samples.slice(-points),
      previous,
      error,
    }
  }

  return { path, load, push, flush, dispose, status }
}