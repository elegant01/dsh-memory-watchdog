import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  SIGNAL_HANDLE_MS,
  SIGNAL_HANDLE_POINTS,
  SIGNAL_LOOP_RESOLUTION_MS,
  SIGNAL_WARNING_ITEMS,
} from './constants.js'
import { capText } from './util.js'

const NANOS_PER_MS = 1e6

function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Cheap runtime signals that need no sampling: warning storms, active handle
 * counts and event-loop delay. All three are read from the Host process itself
 * and never attach to anything external.
 */
export function createSignals({ now = Date.now, intervalMs = SIGNAL_HANDLE_MS, points = SIGNAL_HANDLE_POINTS } = {}) {
  let installed = false
  let installedAt = null
  let timer = null
  let histogram = null
  let loop = null
  const warnings = { total: 0, byName: new Map(), recent: [] }
  const uncaught = { total: 0, recent: [] }
  const handleSeries = []

  function onWarning(warning) {
    const name = typeof warning?.name === 'string' && warning.name.length > 0 ? warning.name : 'Warning'
    warnings.total += 1
    warnings.byName.set(name, (warnings.byName.get(name) ?? 0) + 1)
    warnings.recent.push({ at: now(), name, message: capText(warning?.message ?? '', 200) })
    if (warnings.recent.length > SIGNAL_WARNING_ITEMS) warnings.recent.splice(0, warnings.recent.length - SIGNAL_WARNING_ITEMS)
  }

  function onUncaught(error, origin) {
    uncaught.total += 1
    uncaught.recent.push({
      at: now(),
      origin: typeof origin === 'string' ? origin : 'unknown',
      message: capText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 200),
    })
    if (uncaught.recent.length > SIGNAL_WARNING_ITEMS) uncaught.recent.splice(0, uncaught.recent.length - SIGNAL_WARNING_ITEMS)
  }

  function countHandles() {
    let info = []
    try {
      info = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []
    } catch {
      info = []
    }
    const byType = new Map()
    for (const type of info) {
      const name = typeof type === 'string' ? type : 'unknown'
      byType.set(name, (byType.get(name) ?? 0) + 1)
    }
    return {
      total: info.length,
      byType: [...byType.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    }
  }

  function readLoop() {
    if (histogram === null) return null
    const at = now()
    const count = histogram.count
    if (count === 0) return loop
    const next = {
      at,
      count,
      meanMs: round1(histogram.mean / NANOS_PER_MS),
      p99Ms: round1(histogram.percentile(99) / NANOS_PER_MS),
      maxMs: round1(histogram.max / NANOS_PER_MS),
    }
    histogram.reset()
    loop = next
    return loop
  }

  function sample() {
    const handles = countHandles()
    handleSeries.push({ at: now(), total: handles.total, byType: handles.byType.slice(0, 5) })
    if (handleSeries.length > points) handleSeries.splice(0, handleSeries.length - points)
    readLoop()
  }

  function install() {
    if (installed) return false
    installed = true
    installedAt = now()
    process.on('warning', onWarning)
    process.on('uncaughtExceptionMonitor', onUncaught)
    try {
      histogram = monitorEventLoopDelay({ resolution: SIGNAL_LOOP_RESOLUTION_MS })
      histogram.enable()
    } catch {
      histogram = null
    }
    sample()
    timer = setInterval(sample, intervalMs)
    timer.unref?.()
    return true
  }

  function uninstall() {
    if (!installed) return false
    installed = false
    process.removeListener('warning', onWarning)
    process.removeListener('uncaughtExceptionMonitor', onUncaught)
    if (histogram !== null) {
      histogram.disable()
      histogram = null
    }
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    return true
  }

  function snapshot() {
    const latest = handleSeries.length > 0 ? handleSeries[handleSeries.length - 1] : null
    const first = handleSeries.length > 0 ? handleSeries[0] : null
    return {
      enabled: installed,
      installedAt,
      warnings: {
        total: warnings.total,
        byName: [...warnings.byName.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
        recent: warnings.recent.slice(-5),
      },
      uncaught: { total: uncaught.total, recent: uncaught.recent.slice(-3) },
      handles: {
        total: latest === null ? 0 : latest.total,
        byType: latest === null ? [] : latest.byType,
        series: handleSeries.slice(-points).map((entry) => ({ at: entry.at, total: entry.total })),
        trend: latest === null || first === null ? 0 : latest.total - first.total,
        points: handleSeries.length,
      },
      loop,
    }
  }

  return { install, uninstall, snapshot, sample, installed: () => installed }
}