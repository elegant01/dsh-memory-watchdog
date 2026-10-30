import { join } from 'node:path'
import {
  BLACKBOX_FILE,
  HISTORY_LIMIT,
  PLUGIN_FILE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  TREND_FILE,
} from './constants.js'
import { redactValue } from './redact.js'
import { readJsonFile, safeErrorMessage } from './util.js'

/**
 * The diagnostic bundle is the one artefact that leaves this machine, so it is
 * assembled from already-written files instead of live objects where possible,
 * and the whole thing goes through `redactValue` before it is serialised.
 *
 * Included: a status summary, the last events, the trend file, the plugin
 * memory file, the black box and the capability probe. Excluded on purpose:
 * heap profiles and heap snapshots (they contain raw heap contents, which no
 * amount of path scrubbing makes safe), and any log text.
 */
const BUNDLE_VERSION = 1
const BUNDLE_EVENT_ITEMS = HISTORY_LIMIT

function statusSummary(status) {
  if (status === null || typeof status !== 'object') return null
  const plugin = status.plugin ?? {}
  const platform = status.platform ?? {}
  const pressure = status.pressure ?? {}
  const autoRestart = status.autoRestart ?? {}
  const capability = autoRestart.capability ?? {}
  const gate = status.gate ?? {}
  const attribution = status.attribution ?? {}
  const system = status.system ?? {}
  const crashes = status.crashes ?? {}
  const resume = status.resume ?? {}
  const plugins = status.plugins ?? {}
  const collector = status.collector ?? {}
  return {
    ok: status.ok,
    plugin: { name: plugin.name ?? PLUGIN_NAME, version: plugin.version ?? PLUGIN_VERSION, startedAt: plugin.startedAt ?? null },
    platform: { platform: platform.platform ?? null, arch: platform.arch ?? null, supported: platform.supported ?? null, reason: platform.reason ?? null },
    pressure: {
      state: pressure.state ?? null,
      pct: pressure.pct ?? null,
      commitUsed: pressure.commitUsed ?? null,
      commitLimit: pressure.commitLimit ?? null,
      availableCommit: pressure.availableCommit ?? null,
      stale: pressure.stale ?? null,
      sampleAgeMs: pressure.sampleAgeMs ?? null,
    },
    collector: {
      maxDeliveryLagMs: collector.maxDeliveryLagMs ?? null,
      staleBlips: collector.staleBlips ?? null,
    },
    thresholds: status.config?.thresholds ?? null,
    autoRestart: { enabled: autoRestart.enabled ?? null, capability: { state: capability.state ?? null, reason: capability.reason ?? null } },
    gate: { code: gate.code ?? null, sharePct: gate.sharePct ?? null, gatePct: gate.gatePct ?? null },
    attribution: {
      ok: attribution.ok ?? null,
      dshBytes: attribution.dshBytes ?? null,
      systemCommitUsed: attribution.systemCommitUsed ?? null,
      sharePct: attribution.sharePct ?? null,
    },
    system: {
      ok: system.ok ?? null,
      commitUsed: system.commitUsed ?? null,
      commitLimit: system.commitLimit ?? null,
      physicalTotal: system.physicalTotal ?? null,
      pagefiles: system.pagefiles ?? null,
    },
    crashes: { ok: crashes.ok ?? null, crashCount: crashes.crashCount ?? null, eventCount: crashes.eventCount ?? null, days: crashes.days ?? null },
    resume: { enabled: resume.enabled ?? null },
    plugins: {
      enabled: plugins.enabled ?? null,
      totals: plugins.totals ?? null,
      radar: plugins.radar ?? null,
      inventory: plugins.inventory?.count ?? null,
      packages: plugins.packages ?? null,
    },
    trend: status.trend ?? null,
    lastError: status.lastError ?? null,
  }
}

function prunePluginFile(value) {
  if (value === null || typeof value !== 'object') return null
  const windows = Array.isArray(value.windows) ? value.windows : []
  return {
    version: value.version ?? null,
    updatedAt: value.updatedAt ?? null,
    lastSampleAt: value.lastSampleAt ?? null,
    lastGc: value.lastGc ?? null,
    windows: windows.map((window) => ({
      at: window?.at ?? null,
      totalBytes: window?.totalBytes ?? null,
      durationMs: window?.durationMs ?? null,
      packages: window?.packages ?? null,
    })),
    ledger: value.ledger ?? null,
    reloads: value.reloads ?? null,
  }
}

export function createBundle({ dir, now = Date.now, runtime }) {
  async function readOr(path, label) {
    const result = await readJsonFile(path)
    if (result.ok) return { label, ok: true, value: result.value }
    return { label, ok: false, error: result.code === 'ENOENT' ? 'not written yet' : result.error }
  }

  async function build() {
    const at = now()
    let status = null
    let statusError = null
    try {
      status = typeof runtime?.status === 'function' ? runtime.status() : null
    } catch (error) {
      statusError = safeErrorMessage(error)
    }

    const [trend, plugin, blackbox, capability] = await Promise.all([
      readOr(join(dir, TREND_FILE), 'trend'),
      readOr(join(dir, PLUGIN_FILE), 'plugin-memory'),
      readOr(join(dir, BLACKBOX_FILE), 'blackbox'),
      readOr(join(dir, 'capability.json'), 'capability'),
    ])

    const events = typeof runtime?.historyItems === 'function' ? runtime.historyItems(BUNDLE_EVENT_ITEMS) : []

    const raw = {
      bundle: {
        version: BUNDLE_VERSION,
        plugin: PLUGIN_NAME,
        generatedAt: at,
        // Says plainly what was left out, so nobody has to guess why a heap
        // profile is missing from a bundle they were asked to send.
        excluded: ['heap profiles', 'heap snapshots', 'log text'],
      },
      status: statusSummary(status),
      statusError,
      events: Array.isArray(events) ? events : [],
      trend: trend.ok ? trend.value : { ok: false, error: trend.error },
      pluginMemory: plugin.ok ? prunePluginFile(plugin.value) : { ok: false, error: plugin.error },
      blackbox: blackbox.ok ? blackbox.value : { ok: false, error: blackbox.error },
      capability: capability.ok ? capability.value : { ok: false, error: capability.error },
    }

    const redacted = redactValue(raw)
    const body = JSON.stringify(redacted, null, 2) + '\n'
    return {
      ok: true,
      at,
      filename: `${PLUGIN_NAME}-diagnostics-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`,
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
      counts: {
        events: Array.isArray(redacted.events) ? redacted.events.length : 0,
        trendBuckets: Array.isArray(redacted.trend?.buckets) ? redacted.trend.buckets.length : 0,
        pluginWindows: Array.isArray(redacted.pluginMemory?.windows) ? redacted.pluginMemory.windows.length : 0,
      },
    }
  }

  return { build, dir }
}
