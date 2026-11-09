import {
  RENDERER_REPORT_MIN_INTERVAL_MS,
  RENDERER_SANITY_MAX_BYTES,
  RENDERER_STALE_MS,
} from './constants.js'

/**
 * The renderer's own heap total, reported by the panel and nothing else.
 *
 * This is deliberately *only* a total: it says the window is holding 1.4 GiB, it
 * never claims which plugin is responsible, because a renderer cannot attribute
 * its heap to a plugin without instrumentation the page does not have. The host
 * accepts the number, sanity-checks it and forgets it after a while, so a client
 * that stops reporting cannot leave a stale figure looking live.
 */
const UNKNOWN = Object.freeze({
  available: false,
  usedBytes: null,
  totalBytes: null,
  limitBytes: null,
  reportedAt: null,
  ageMs: null,
  stale: false,
  reason: 'not-reported',
})

function finiteBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (number < 0 || number > RENDERER_SANITY_MAX_BYTES) return null
  return Math.round(number)
}

export function createRendererHeap({ now = Date.now } = {}) {
  let reading = null
  let acceptedAt = null

  function status(at = now()) {
    if (reading === null) return { ...UNKNOWN }
    const ageMs = Number.isFinite(at) && Number.isFinite(reading.reportedAt) ? Math.max(0, at - reading.reportedAt) : null
    const stale = ageMs === null || ageMs > RENDERER_STALE_MS
    // A page that had no `performance.memory` recorded a reading with no bytes;
    // that is a known "unsupported", not a live figure, so it never counts as
    // available even while it is fresh.
    const known = Number.isFinite(reading.usedBytes)
    return {
      available: !stale && known,
      // Kept even when stale: hiding the last known figure makes the card jump
      // from "1.4 GiB" to "—" for no reason the user can see.
      usedBytes: reading.usedBytes,
      totalBytes: reading.totalBytes,
      limitBytes: reading.limitBytes,
      reportedAt: reading.reportedAt,
      ageMs,
      stale,
      reason: !known ? 'unsupported' : stale ? 'stale' : null,
    }
  }

  function report(input, at = now()) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, accepted: false, reason: 'invalid-body' }
    }
    if (input.available === false) {
      // The page looked for `performance.memory` and did not find it. Remember
      // that so the card can explain the absence instead of staying silent.
      reading = {
        usedBytes: null,
        totalBytes: null,
        limitBytes: null,
        reportedAt: Number.isFinite(at) ? at : now(),
      }
      acceptedAt = reading.reportedAt
      return { ok: true, accepted: true, reason: 'unsupported' }
    }
    const usedBytes = finiteBytes(input.usedBytes)
    if (usedBytes === null) return { ok: false, accepted: false, reason: 'invalid-used-bytes' }
    if (acceptedAt !== null && Number.isFinite(at) && at - acceptedAt < RENDERER_REPORT_MIN_INTERVAL_MS) {
      // Throttled rather than rejected: the client did nothing wrong, it just
      // polled faster than the stale window needs.
      return { ok: true, accepted: false, reason: 'throttled', retryInMs: RENDERER_REPORT_MIN_INTERVAL_MS - (at - acceptedAt) }
    }
    reading = {
      usedBytes,
      totalBytes: finiteBytes(input.totalBytes),
      limitBytes: finiteBytes(input.limitBytes),
      reportedAt: Number.isFinite(at) ? at : now(),
    }
    acceptedAt = reading.reportedAt
    return { ok: true, accepted: true, reason: null }
  }

  function reset() {
    reading = null
    acceptedAt = null
  }

  return { report, status, reset }
}
