import {
  HEALTH_GRADE_FAIR,
  HEALTH_GRADE_GOOD,
  HEALTH_GRADE_POOR,
  HEALTH_GROWTH_BAD_MB_PER_HOUR,
  HEALTH_GROWTH_GOOD_MB_PER_HOUR,
  HEALTH_LOOP_P99_BAD_MS,
  HEALTH_LOOP_P99_GOOD_MS,
  HEALTH_RENDERER_BAD_BYTES,
  HEALTH_RENDERER_WARN_BYTES,
} from './constants.js'

/**
 * A single 0-100 figure is only trustworthy if the number it came from is on
 * screen next to it, so every component carries its own raw value, its weight
 * and the penalty it contributed. The score is just `100 - sum(penalty)`.
 *
 * The weights add up to 100 and each penalty is capped at its own weight, so no
 * single signal can drag the score to zero on its own except by being maximally
 * bad. Missing data never counts as a penalty: a component that cannot be read
 * is reported as `available: false` and contributes nothing, because punishing
 * the user for a probe that has not run yet would be a lie.
 */
export const HEALTH_WEIGHTS = {
  pressure: 30,
  growth: 20,
  crashes: 15,
  plugins: 15,
  loop: 10,
  renderer: 10,
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function rounded(value, digits = 0) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function ratio(value, good, bad) {
  if (!Number.isFinite(value)) return null
  if (bad === good) return value >= bad ? 1 : 0
  return clamp01((value - good) / (bad - good))
}

function pressureComponent(pressure, thresholds) {
  const weight = HEALTH_WEIGHTS.pressure
  const pct = Number(pressure?.pct)
  if (pressure?.stale === true || !Number.isFinite(pct)) {
    return {
      key: 'pressure',
      weight,
      penalty: 0,
      available: false,
      value: null,
      detail: pressure?.stale === true ? 'stale' : 'unavailable',
    }
  }
  const warning = Number(thresholds?.warningPct)
  const floor = Number.isFinite(warning) ? warning : 80
  // Zero penalty below the warning threshold; full penalty at 100%.
  const penalty = weight * clamp01((pct - floor) / Math.max(1, 100 - floor))
  return { key: 'pressure', weight, penalty, available: true, value: rounded(pct, 1), detail: null }
}

function growthSlopeMbPerHour(trend, commitLimit) {
  const buckets = Array.isArray(trend?.buckets) ? trend.buckets : []
  const usable = buckets.filter((bucket) => bucket !== null && typeof bucket === 'object' && Number(bucket.n) > 0 && Number.isFinite(bucket.avg) && Number.isFinite(bucket.at))
  if (usable.length < 2) return null
  const first = usable[0]
  const last = usable[usable.length - 1]
  const spanMs = last.at - first.at
  if (!(spanMs >= 30 * 60 * 1000)) return null
  if (!Number.isFinite(commitLimit) || commitLimit <= 0) return null
  const deltaPct = last.avg - first.avg
  const hours = spanMs / (60 * 60 * 1000)
  const pctPerHour = deltaPct / hours
  // pct of the commit limit per hour, expressed in MiB so it matches the
  // per-hour growth numbers shown elsewhere in the card.
  return (pctPerHour / 100) * (commitLimit / (1024 * 1024))
}

function growthComponent(pressure, trend) {
  const weight = HEALTH_WEIGHTS.growth
  const slope = growthSlopeMbPerHour(trend, Number(pressure?.commitLimit))
  if (slope === null) return { key: 'growth', weight, penalty: 0, available: false, value: null, detail: 'not-enough-data' }
  // A shrinking commit charge is not a problem, so the slope is clamped at 0.
  const penalty = weight * ratio(Math.max(0, slope), HEALTH_GROWTH_GOOD_MB_PER_HOUR, HEALTH_GROWTH_BAD_MB_PER_HOUR)
  return { key: 'growth', weight, penalty, available: true, value: rounded(slope, 1), detail: null }
}

function crashesComponent(crashes) {
  const weight = HEALTH_WEIGHTS.crashes
  const count = Number(crashes?.crashCount)
  if (crashes?.ok === false || !Number.isFinite(count)) {
    return { key: 'crashes', weight, penalty: 0, available: false, value: null, detail: crashes?.error ?? 'unavailable' }
  }
  // One recent crash is a fact of life; the second and third are the signal.
  const penalty = weight * clamp01((count - 1) / 3)
  return { key: 'crashes', weight, penalty, available: true, value: count, detail: null }
}

function pluginsComponent(plugins) {
  const weight = HEALTH_WEIGHTS.plugins
  const packages = Array.isArray(plugins?.packages) ? plugins.packages : []
  if (plugins?.enabled !== true) return { key: 'plugins', weight, penalty: 0, available: false, value: null, detail: 'disabled' }
  const high = packages.filter((entry) => entry?.level === 'high').length
  const medium = packages.filter((entry) => entry?.level === 'medium').length
  const penalty = weight * clamp01(high / 3 + medium / 12)
  return { key: 'plugins', weight, penalty, available: true, value: high, detail: `${high}/${packages.length}` }
}

function loopComponent(signals) {
  const weight = HEALTH_WEIGHTS.loop
  const p99 = Number(signals?.loop?.p99Ms)
  if (signals?.enabled !== true || !Number.isFinite(p99)) {
    return { key: 'loop', weight, penalty: 0, available: false, value: null, detail: 'unavailable' }
  }
  const penalty = weight * ratio(p99, HEALTH_LOOP_P99_GOOD_MS, HEALTH_LOOP_P99_BAD_MS)
  return { key: 'loop', weight, penalty, available: true, value: rounded(p99, 1), detail: null }
}

function rendererComponent(renderer) {
  const weight = HEALTH_WEIGHTS.renderer
  const bytes = Number(renderer?.usedBytes)
  if (renderer?.available !== true || !Number.isFinite(bytes)) {
    return { key: 'renderer', weight, penalty: 0, available: false, value: null, detail: renderer?.reason ?? 'unavailable' }
  }
  const penalty = weight * ratio(bytes, HEALTH_RENDERER_WARN_BYTES, HEALTH_RENDERER_BAD_BYTES)
  return { key: 'renderer', weight, penalty, available: true, value: bytes, detail: null }
}

export function gradeOf(score) {
  if (!Number.isFinite(score)) return 'unknown'
  if (score >= HEALTH_GRADE_GOOD) return 'good'
  if (score >= HEALTH_GRADE_FAIR) return 'fair'
  if (score >= HEALTH_GRADE_POOR) return 'poor'
  return 'bad'
}

export function computeHealth({ status = {}, renderer = null, thresholds = null } = {}) {
  const resolved = thresholds ?? status?.config?.thresholds ?? null
  const components = [
    pressureComponent(status.pressure, resolved),
    growthComponent(status.pressure, status.trend),
    crashesComponent(status.crashes),
    pluginsComponent(status.plugins),
    loopComponent(status.signals),
    rendererComponent(renderer),
  ]
  const penalty = components.reduce((sum, item) => sum + item.penalty, 0)
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)))
  const ranked = [...components].sort((left, right) => right.penalty - left.penalty)
  return {
    score,
    grade: gradeOf(score),
    // Only components that actually cost points are worth explaining; a list of
    // six zeros would bury the one line that matters.
    penalties: ranked.filter((item) => item.penalty >= 0.5).map((item) => ({
      key: item.key,
      penalty: Math.round(item.penalty * 10) / 10,
      weight: item.weight,
      value: item.value,
      detail: item.detail,
    })),
    components: components.map((item) => ({
      key: item.key,
      weight: item.weight,
      penalty: Math.round(item.penalty * 10) / 10,
      available: item.available,
      value: item.value,
      detail: item.detail,
    })),
    weights: { ...HEALTH_WEIGHTS },
  }
}
