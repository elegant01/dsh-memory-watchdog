import {
  CRITICAL_PCT,
  HEAP_EXTERNAL_GROWTH_MB,
  HEAP_EXTERNAL_KEEP_MS,
  HEAP_EXTERNAL_MARK_MS,
  HEAP_EXTERNAL_RATE_WINDOW_MS,
  HEAP_EXTERNAL_SPAN_MS,
  HEAP_NEAR_LIMIT_PCT,
  HEAP_NEAR_RECOVER_PCT,
  HEAP_NEAR_SAMPLES,
  OOM_EXTERNAL_MIN_BYTES,
  OOM_EXTERNAL_SHARE_PCT,
  OOM_HEAP_RATIO_PCT,
} from './constants.js'

const MIB = 1024 * 1024
const HOUR_MS = 60 * 60 * 1000

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function heapRatioPct(used, total) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  return Math.round((used / total) * 1000) / 10
}

function normalizeSample(sample) {
  const at = numberOrNull(sample?.at)
  if (at === null) return null
  return {
    at,
    pct: numberOrNull(sample.pct),
    rss: numberOrNull(sample.rss),
    heapUsed: numberOrNull(sample.heapUsed),
    heapTotal: numberOrNull(sample.heapTotal),
    external: numberOrNull(sample.external),
    arrayBuffers: numberOrNull(sample.arrayBuffers),
  }
}

/**
 * Watches the two ways a Node process dies without a JS stack: the JS heap
 * crawling towards its own ceiling, and off-heap buffers ("external" memory)
 * growing fast enough that the system commit limit will be reached first.
 *
 * Near-limit needs consecutive samples so a single GC spike never alerts, and
 * recovery uses a lower threshold than the trigger so an alert does not flap.
 */
export function createHeapWatch({
  now = Date.now,
  nearLimitPct = HEAP_NEAR_LIMIT_PCT,
  recoverPct = HEAP_NEAR_RECOVER_PCT,
  sampleCount = HEAP_NEAR_SAMPLES,
  externalGrowthMb = HEAP_EXTERNAL_GROWTH_MB,
  markMs = HEAP_EXTERNAL_MARK_MS,
  spanMs = HEAP_EXTERNAL_SPAN_MS,
  rateWindowMs = HEAP_EXTERNAL_RATE_WINDOW_MS,
  keepMs = HEAP_EXTERNAL_KEEP_MS,
} = {}) {
  const recent = []
  const marks = []
  let nearLimit = false

  function record(sample) {
    const entry = normalizeSample(sample)
    if (entry === null) return null
    recent.push(entry)
    const keepPoints = Math.max(2, sampleCount, 6)
    if (recent.length > keepPoints) recent.splice(0, recent.length - keepPoints)

    if (nearLimit) {
      const latest = heapRatioPct(entry.heapUsed, entry.heapTotal)
      if (latest !== null && latest < recoverPct) nearLimit = false
    }
    if (recent.length >= sampleCount) {
      const ratios = recent.slice(-sampleCount).map((point) => heapRatioPct(point.heapUsed, point.heapTotal))
      if (ratios.every((value) => value !== null && value >= nearLimitPct)) nearLimit = true
    }

    const lastMark = marks[marks.length - 1]
    if (lastMark === undefined || entry.at - lastMark.at >= markMs) {
      marks.push(entry)
      const cutoff = entry.at - keepMs
      while (marks.length > 2 && marks[0].at < cutoff) marks.shift()
    }
    return entry
  }

  function externalRateMbPerHour() {
    const last = marks[marks.length - 1]
    if (last === undefined || last.external === null) return null
    const floor = last.at - rateWindowMs
    const oldest = marks.find((mark) => mark.at >= floor && mark.external !== null) ?? null
    if (oldest === null || oldest === last) return null
    const span = last.at - oldest.at
    if (span < spanMs) return null
    return Math.round(((last.external - oldest.external) / MIB / span) * HOUR_MS * 10) / 10
  }

  function snapshot(at = now()) {
    const latest = recent[recent.length - 1] ?? null
    const ratioPct = latest === null ? null : heapRatioPct(latest.heapUsed, latest.heapTotal)
    const externalBytes = latest?.external ?? null
    const arrayBuffersBytes = latest?.arrayBuffers ?? null
    return {
      at,
      nearLimit,
      ratioPct,
      heapUsed: latest?.heapUsed ?? null,
      heapTotal: latest?.heapTotal ?? null,
      rss: latest?.rss ?? null,
      externalBytes,
      arrayBuffersBytes,
      externalRateMbPerHour: externalRateMbPerHour(),
      samples: recent.length,
      thresholds: {
        nearLimitPct,
        recoverPct,
        sampleCount,
        externalGrowthMb,
        externalSpanMs: spanMs,
      },
    }
  }

  return { record, status: snapshot, snapshot }
}

/**
 * Turns the last blackbox sample of a crash into one of the three classes the
 * card can explain: the JS heap ran out, off-heap buffers ran out, or the
 * process died while the machine itself was out of commit charge.
 */
export function classifyCrashTrail(trail) {
  const samples = Array.isArray(trail?.samples) ? trail.samples : []
  const last = samples[samples.length - 1] ?? null
  if (last === null) return null
  const heapUsed = numberOrNull(last.heapUsed)
  const heapTotal = numberOrNull(last.heapTotal)
  const ratioPct = heapRatioPct(heapUsed, heapTotal)
  const external = numberOrNull(last.external)
  const arrayBuffersValue = numberOrNull(last.arrayBuffers)
  const arrayBuffers = arrayBuffersValue ?? 0
  const externalBytes = external === null ? null : external + arrayBuffers
  const rss = numberOrNull(last.rss)
  const commitPct = numberOrNull(last.pct)
  const externalSharePct =
    externalBytes !== null && rss !== null && rss > 0 ? Math.round((externalBytes / rss) * 1000) / 10 : null
  let oomClass = null
  if (ratioPct !== null && ratioPct >= OOM_HEAP_RATIO_PCT) oomClass = 'oom-heap'
  else if (
    externalBytes !== null &&
    externalBytes >= OOM_EXTERNAL_MIN_BYTES &&
    externalSharePct !== null &&
    externalSharePct >= OOM_EXTERNAL_SHARE_PCT
  )
    oomClass = 'oom-external'
  else if (commitPct !== null && commitPct >= CRITICAL_PCT) oomClass = 'oom-system'
  return {
    oomClass,
    heapUsed,
    heapTotal,
    ratioPct,
    externalBytes,
    arrayBuffersBytes: arrayBuffersValue,
    externalSharePct,
    commitPct,
  }
}