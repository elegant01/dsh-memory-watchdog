import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HEAP_PROFILE_PREFIX,
  HEAP_SNAPSHOT_PREFIX,
  PLUGIN_BASELINE_DELAY_MS,
  PLUGIN_FILE,
  PLUGIN_HISTORY_ITEMS,
  PLUGIN_INVENTORY_REFRESH_MS,
  PLUGIN_LEAK_MB,
  PLUGIN_MAX_WINDOWS,
  PLUGIN_MIN_SPAN_MS,
  PLUGIN_SAMPLE_MINUTES,
  PLUGIN_SAMPLING_INTERVAL,
  PLUGIN_STRUCTURAL_GROWTH,
  PLUGIN_TOP_N,
  PLUGIN_WINDOW_MS,
} from './constants.js'
import {
  aggregateProfile,
  inspectorAvailable,
  memorySnapshot,
  sampleHeap,
  takeHeapSnapshot,
  writeHeapProfile,
} from './heap-sampler.js'
import { createPluginRadar } from './plugin-radar.js'
import { loadPluginInventory } from './plugin-inventory.js'
import { readJsonFile, safeErrorMessage, writeJsonAtomic } from './util.js'

const EXCLUDED_KEYS = new Set(['(native)', '(builtin)', '(unknown)', '(local)', 'dsh'])
const MIB = 1024 * 1024
const LEVELS = ['low', 'medium', 'high', 'unknown']

export function normalizePluginConfig(raw = {}) {
  const number = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  return {
    enabled: raw.pluginMemory !== false,
    sampling: raw.pluginSampling !== false,
    sampleMinutes: number(raw.pluginSampleMinutes, PLUGIN_SAMPLE_MINUTES, 5, 120),
    sampleSeconds: number(raw.pluginSampleSeconds, PLUGIN_WINDOW_MS / 1000, 5, 120),
    leakMb: number(raw.pluginLeakMb, PLUGIN_LEAK_MB, 8, 512),
  }
}

function hoursBetween(left, right) {
  return (right - left) / 3_600_000
}

export function growthSlope(points) {
  if (points.length < 2) return null
  const first = points[0]
  const xs = points.map((point) => hoursBetween(first.at, point.at))
  const span = xs[xs.length - 1]
  if (!(span > 0)) return null
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = points.reduce((sum, point) => sum + point.bytes, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < points.length; index += 1) {
    numerator += (xs[index] - meanX) * (points[index].bytes - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  if (denominator === 0) return null
  return numerator / denominator
}

function radarSeries(windows, key) {
  return windows
    .map((window) => {
      const entry = window.radar?.[key]
      return entry === undefined ? null : { at: window.at, timers: entry.timers, listeners: entry.listeners }
    })
    .filter((entry) => entry !== null)
}

function structuralGrowth(series) {
  if (series.length < 2) return 0
  const first = series[0]
  const last = series[series.length - 1]
  return last.timers + last.listeners - (first.timers + first.listeners)
}

export function assessPlugins({ windows = [], radar = null, inventory = [], leakMb = PLUGIN_LEAK_MB, ownPackage = null } = {}) {
  const keys = new Map()
  // Every plugin the host actually installed is listed even before the first
  // heap window exists, so the table is an inventory and not an empty shell.
  for (const entry of inventory) {
    if (EXCLUDED_KEYS.has(entry.key)) continue
    if (ownPackage !== null && entry.key === ownPackage) continue
    keys.set(entry.key, { key: entry.key, name: entry.name, kind: entry.kind, installed: true, version: entry.version ?? null })
  }
  for (const window of windows) {
    for (const entry of window.packages ?? []) {
      if (EXCLUDED_KEYS.has(entry.key)) continue
      if (ownPackage !== null && entry.key === ownPackage) continue
      if (!keys.has(entry.key)) keys.set(entry.key, { key: entry.key, name: entry.name, kind: entry.kind, installed: false, version: null })
    }
  }
  const windowKeys = new Set()
  for (const window of windows) {
    for (const entry of window.packages ?? []) windowKeys.add(entry.key)
  }
  for (const entry of radar?.packages ?? []) {
    if (EXCLUDED_KEYS.has(entry.key)) continue
    if (ownPackage !== null && entry.key === ownPackage) continue
    // Radar-only rows that are neither installed plugins nor sampled in a window
    // are framework packages (cordis, electron helpers); listing them would only
    // add noise, so they are dropped as long as we do have an inventory to trust.
    if (inventory.length > 0 && !keys.has(entry.key) && !windowKeys.has(entry.key)) continue
    if (!keys.has(entry.key)) keys.set(entry.key, { key: entry.key, name: entry.name, kind: entry.kind, installed: false, version: null })
  }

  const latest = windows.length > 0 ? windows[windows.length - 1] : null
  const latestTotal = latest === null ? 0 : latest.totalBytes
  const result = []
  const leakBytes = leakMb * MIB

  for (const identity of keys.values()) {
    const points = windows
      .map((window) => {
        const entry = (window.packages ?? []).find((candidate) => candidate.key === identity.key)
        return entry === undefined ? null : { at: window.at, bytes: entry.bytes }
      })
      .filter((entry) => entry !== null)
    const latestEntry = latest === null ? null : (latest.packages ?? []).find((entry) => entry.key === identity.key)
    const bytes = latestEntry === undefined || latestEntry === null ? (points.at(-1)?.bytes ?? 0) : latestEntry.bytes
    const span = points.length > 1 ? points.at(-1).at - points[0].at : 0
    const slope = span >= PLUGIN_MIN_SPAN_MS ? growthSlope(points) : null
    const radarPackages = radar?.packages ?? []
    const radarEntry = radarPackages.find((entry) => entry.key === identity.key) ?? null
    const series = radarSeries(windows, identity.key)
    const structureDelta = structuralGrowth(series)

    let level = 'unknown'
    const reasons = []
    if (slope !== null) {
      if (slope >= leakBytes) {
        level = 'high'
        reasons.push('bytes-growth')
      } else if (slope >= leakBytes * 0.4) {
        level = 'medium'
        reasons.push('bytes-growth')
      } else {
        level = 'low'
      }
    } else if (points.length >= 2) {
      level = 'low'
      reasons.push('short-span')
    }
    if (structureDelta >= PLUGIN_STRUCTURAL_GROWTH) {
      reasons.push('handle-growth')
      if (level !== 'high' && slope !== null && slope >= leakBytes * 0.4) level = 'high'
      else if (level === 'unknown' || level === 'low') level = 'medium'
    }
    if (level === 'unknown') reasons.push('not-enough-data')

    result.push({
      key: identity.key,
      name: identity.name,
      kind: identity.kind,
      installed: identity.installed === true,
      version: identity.version ?? null,
      bytes,
      nodes: latestEntry?.nodes ?? 0,
      share: latestTotal > 0 && bytes > 0 ? Math.round((bytes / latestTotal) * 1000) / 10 : 0,
      timers: radarEntry?.timers ?? 0,
      listeners: radarEntry?.listeners ?? 0,
      timerPeak: radarEntry?.timerPeak ?? 0,
      listenerPeak: radarEntry?.listenerPeak ?? 0,
      structureDelta,
      growthBytesPerHour: slope === null ? null : Math.round(slope),
      samples: points.length,
      spanMs: span,
      level,
      reasons,
      top: (latestEntry?.top ?? []).slice(0, PLUGIN_TOP_N),
    })
  }

  result.sort((left, right) => {
    const rank = (item) => LEVELS.indexOf(item.level)
    if (rank(left) !== rank(right)) return rank(right) - rank(left)
    return right.bytes - left.bytes
  })
  return result
}

export class PluginMemory {
  constructor({ dir, config = {}, now = Date.now, ownPackage = null, env } = {}) {
    this.dir = dir
    this.now = now
    this.ownPackage = ownPackage
    this.env = env
    this.config = normalizePluginConfig(config)
    this.file = join(dir, PLUGIN_FILE)
    this.radar = createPluginRadar({ now: this.now, ownPackage: this.ownPackage })
    this.inventory = { ownDir: null, profileDir: null, plugins: [], dirs: [] }
    this.inventoryAt = null
    this.windows = []
    this.ledger = {}
    this.state = 'idle'
    this.inflight = null
    this.timer = null
    this.lastSampleAt = null
    this.nextSampleAt = null
    this.lastGc = null
    this.lastError = null
    this.lastExport = null
    this.lastSnapshot = null
    this.lastAggregate = null
    this.lastWindow = null
    this.lastProfile = null
    this.startedAt = null
  }

  get path() {
    return this.file
  }

  async load() {
    const loaded = await readJsonFile(this.file)
    if (loaded.ok && loaded.value !== null && typeof loaded.value === 'object') {
      const windows = Array.isArray(loaded.value.windows) ? loaded.value.windows : []
      this.windows = windows.slice(-PLUGIN_MAX_WINDOWS)
      this.ledger = loaded.value.ledger !== null && typeof loaded.value.ledger === 'object' ? loaded.value.ledger : {}
      this.lastSampleAt = typeof loaded.value.lastSampleAt === 'number' ? loaded.value.lastSampleAt : null
      this.lastGc = loaded.value.lastGc !== null && typeof loaded.value.lastGc === 'object' ? loaded.value.lastGc : null
    }
    return loaded.ok
  }

  async persist() {
    await writeJsonAtomic(this.file, {
      version: 1,
      updatedAt: this.now(),
      lastSampleAt: this.lastSampleAt,
      lastGc: this.lastGc,
      windows: this.windows.slice(-PLUGIN_MAX_WINDOWS),
      ledger: this.ledger,
    })
  }

  start() {
    if (this.startedAt !== null) return this
    this.startedAt = this.now()
    if (this.config.enabled) {
      this.refreshInventory().catch(() => {})
      this.radar.install()
    }
    if (this.config.sampling) this.scheduleNext(PLUGIN_BASELINE_DELAY_MS)
    return this
  }

  /**
   * Rebuilds the list of plugins installed in this profile and hands the
   * directories to the radar so registrations land on real package names.
   */
  async refreshInventory() {
    if (this.inventoryAt !== null && this.now() - this.inventoryAt < PLUGIN_INVENTORY_REFRESH_MS / 6) {
      return this.inventory
    }
    try {
      const inventory = await loadPluginInventory({ ownPackage: this.ownPackage })
      this.inventory = inventory
      this.inventoryAt = this.now()
      if (this.radar.installed) {
        this.radar.setOwners({ ownDir: inventory.ownDir, ownerDirs: inventory.dirs, ownPackage: this.ownPackage })
      }
    } catch {}
    return this.inventory
  }

  async stop() {
    this.startedAt = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inflight !== null) {
      try {
        await this.inflight
      } catch {}
    }
    this.radar.uninstall()
    return this
  }

  async reconfigure(config = {}) {
    const previous = this.config
    this.config = normalizePluginConfig({ ...this.config, ...config })
    if (!this.config.enabled && this.radar.installed) this.radar.uninstall()
    if (this.config.enabled && !this.radar.installed) this.radar.install()
    if (this.config.sampling && !previous.sampling) this.scheduleNext()
    if (!this.config.sampling && this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
      this.nextSampleAt = null
    }
    return this.config
  }

  scheduleNext(delayMs = null) {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.config.sampling || this.startedAt === null) {
      this.nextSampleAt = null
      return
    }
    const wait = delayMs === null ? Math.max(60_000, this.config.sampleMinutes * 60_000) : Math.max(5_000, delayMs)
    this.nextSampleAt = this.now() + wait
    this.timer = setTimeout(() => {
      this.timer = null
      this.sampleNow('schedule').catch(() => {})
    }, wait)
    if (this.timer !== null && typeof this.timer.unref === 'function') this.timer.unref()
  }

  async sampleNow(reason = 'manual', { keepProfile = false } = {}) {
    if (!this.config.enabled) {
      return { ok: false, error: 'plugin-memory-disabled' }
    }
    if (!inspectorAvailable()) {
      this.lastError = { at: this.now(), code: 'inspector-unavailable' }
      return { ok: false, error: 'inspector-unavailable' }
    }
    if (this.inflight !== null) return this.inflight
    const run = (async () => {
      this.state = 'sampling'
      this.lastError = null
      try {
        await this.refreshInventory()
        const result = await sampleHeap({
          durationMs: this.config.sampleSeconds * 1000,
          samplingInterval: PLUGIN_SAMPLING_INTERVAL,
        })
        const window = this.buildWindow(result, reason)
        this.windows.push(window)
        if (this.windows.length > PLUGIN_MAX_WINDOWS) this.windows = this.windows.slice(-PLUGIN_MAX_WINDOWS)
        this.lastWindow = window
        this.lastAggregate = result.aggregate
        this.lastSampleAt = window.at
        this.lastGc = { at: window.at, ...window.gc }
        this.rememberLedger(window)
        if (keepProfile) this.lastProfile = result.profile
        await this.persist()
        this.state = 'idle'
        return { ok: true, window, aggregate: result.aggregate, elapsedMs: result.elapsedMs }
      } catch (error) {
        this.state = 'idle'
        this.lastError = { at: this.now(), code: 'sampling-failed', message: safeErrorMessage(error) }
        return { ok: false, error: 'sampling-failed', message: this.lastError.message }
      } finally {
        this.inflight = null
        if (this.config.sampling) this.scheduleNext()
      }
    })()
    this.inflight = run
    return run
  }

  buildWindow(result, reason) {
    const radar = this.radar.snapshot()
    const radarByKey = {}
    for (const entry of radar.packages) {
      radarByKey[entry.key] = { timers: entry.timers, listeners: entry.listeners }
    }
    return {
      at: this.now(),
      reason,
      durationMs: result.elapsedMs,
      samplingInterval: result.samplingInterval,
      gc: { applied: result.gcApplied === true, ms: result.gcMs ?? 0, reclaimedBytes: result.gcReclaimedBytes ?? 0 },
      totalBytes: result.aggregate.totalBytes,
      nativeBytes: result.aggregate.nativeBytes,
      attributedBytes: result.aggregate.attributedBytes,
      packages: result.aggregate.packages
        .filter((entry) => entry.key !== '(native)' && entry.key !== '(builtin)' && entry.key !== '(unknown)')
        .map((entry) => ({ key: entry.key, name: entry.name, kind: entry.kind, bytes: entry.bytes, nodes: entry.nodes, top: entry.top.slice(0, 3) })),
      radar: radarByKey,
    }
  }

  rememberLedger(window) {
    for (const entry of window.packages) {
      const existing = this.ledger[entry.key] ?? {
        name: entry.name,
        kind: entry.kind,
        firstSeenAt: window.at,
        baselineBytes: entry.bytes,
        peakBytes: 0,
        samples: 0,
      }
      existing.name = entry.name
      existing.kind = entry.kind
      existing.lastBytes = entry.bytes
      existing.lastAt = window.at
      existing.peakBytes = Math.max(existing.peakBytes ?? 0, entry.bytes)
      existing.samples = (existing.samples ?? 0) + 1
      this.ledger[entry.key] = existing
    }
  }

  async exportProfile() {
    const sampled = await this.sampleNow('export', { keepProfile: true })
    if (!sampled.ok) return sampled
    const profile = this.lastProfile ?? null
    if (profile === null) return { ok: false, error: 'no-profile' }
    const path = join(this.dir, `${HEAP_PROFILE_PREFIX}${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.heapprofile`)
    await writeHeapProfile(profile, path)
    this.lastProfile = null
    const info = await stat(path).catch(() => null)
    this.lastExport = { at: this.now(), path, bytes: info === null ? null : info.size }
    return { ok: true, path, bytes: this.lastExport.bytes, aggregate: sampled.aggregate }
  }

  async takeSnapshot() {
    if (!inspectorAvailable()) return { ok: false, error: 'inspector-unavailable' }
    try {
      const path = join(this.dir, `${HEAP_SNAPSHOT_PREFIX}${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.heapsnapshot`)
      const result = takeHeapSnapshot(path)
      const info = await stat(result.path).catch(() => null)
      this.lastSnapshot = { at: this.now(), path: result.path, bytes: info === null ? null : info.size, elapsedMs: result.elapsedMs }
      await this.pruneSnapshots(2)
      return { ok: true, ...this.lastSnapshot }
    } catch (error) {
      return { ok: false, error: 'snapshot-failed', message: safeErrorMessage(error) }
    }
  }

  async pruneSnapshots(keep) {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.startsWith(HEAP_SNAPSHOT_PREFIX))
      const sorted = []
      for (const name of names) {
        const info = await stat(join(this.dir, name)).catch(() => null)
        sorted.push({ name, mtime: info === null ? 0 : info.mtimeMs })
      }
      sorted.sort((left, right) => right.mtime - left.mtime)
      for (const entry of sorted.slice(keep)) {
        await unlink(join(this.dir, entry.name)).catch(() => {})
      }
    } catch {}
  }

  status() {
    const radar = this.radar.snapshot()
    const packages = assessPlugins({
      windows: this.windows,
      radar,
      inventory: this.inventory.plugins,
      leakMb: this.config.leakMb,
      ownPackage: this.ownPackage,
    })
    const latest = this.lastWindow ?? this.windows.at(-1) ?? null
    const totalBytes = latest?.totalBytes ?? 0
    const coreEntry = latest?.packages?.find((entry) => entry.key === 'dsh') ?? null
    const usage = memorySnapshot()
    return {
      enabled: this.config.enabled,
      inspector: inspectorAvailable(),
      sampling: {
        enabled: this.config.sampling,
        minutes: this.config.sampleMinutes,
        windowSeconds: this.config.sampleSeconds,
        state: this.state,
        lastSampleAt: this.lastSampleAt,
        nextSampleAt: this.nextSampleAt,
        lastError: this.lastError,
        lastGc: this.lastGc,
      },
      limits: { leakMb: this.config.leakMb, minSpanMs: PLUGIN_MIN_SPAN_MS, maxWindows: PLUGIN_MAX_WINDOWS },
      totals: {
        windows: this.windows.length,
        spanMs: this.windows.length > 1 ? this.windows.at(-1).at - this.windows[0].at : 0,
        totalBytes,
        coreBytes: coreEntry === null ? 0 : coreEntry.bytes,
        nativeBytes: latest?.nativeBytes ?? 0,
        attributedBytes: latest?.attributedBytes ?? 0,
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
      },
      radar: { enabled: radar.enabled, totals: radar.totals, owners: radar.owners, debug: radar.debug },
      inventory: {
        profileDir: this.inventory.profileDir,
        count: this.inventory.plugins.length,
        scannedAt: this.inventoryAt,
        plugins: this.inventory.plugins.map((plugin) => ({ key: plugin.key, version: plugin.version })),
      },
      packages: packages.slice(0, PLUGIN_HISTORY_ITEMS),
      history: this.windows.slice(-PLUGIN_HISTORY_ITEMS).map((window) => ({
        at: window.at,
        totalBytes: window.totalBytes,
        packages: window.packages.map((entry) => ({ key: entry.key, bytes: entry.bytes })),
      })),
      lastExport: this.lastExport,
      lastSnapshot: this.lastSnapshot,
      ledger: Object.entries(this.ledger)
        .filter(([key]) => !EXCLUDED_KEYS.has(key) && key !== this.ownPackage)
        .map(([key, entry]) => ({ key, name: entry.name, firstSeenAt: entry.firstSeenAt, lastBytes: entry.lastBytes, peakBytes: entry.peakBytes, samples: entry.samples }))
        .sort((left, right) => right.peakBytes - left.peakBytes)
        .slice(0, PLUGIN_HISTORY_ITEMS),
      dir: this.dir,
    }
  }
}