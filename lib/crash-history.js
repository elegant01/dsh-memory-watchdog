import { CRASH_HISTORY_DAYS, CRASH_HISTORY_LIMIT } from './constants.js'
import { runPowerShellJson } from './ps.js'
import { capText } from './util.js'

const CODE_ORDER = {
  'crash.renderer-oom': 0,
  'crash.host-exit': 1,
  'crash.main': 2,
  'crash.renderer': 3,
  'crash.web-boot': 4,
  'crash.other': 5,
}
const EVENT_CODES = {
  2004: 'system.resource-exhaustion',
  26: 'system.low-virtual-memory',
  41: 'system.unexpected-shutdown',
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function parseCrashLogName(name) {
  const match = /^crash-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z-]+)\.log$/i.exec(String(name ?? ''))
  if (!match) return null
  const at = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  )
  return { at, source: match[8].toLowerCase() }
}

export function extractErrorLine(head) {
  const text = String(head ?? '')
  const marker = text.indexOf('--- error ---')
  if (marker === -1) return null
  const rest = text.slice(marker + '--- error ---'.length)
  const end = rest.indexOf('\n---')
  const body = end === -1 ? rest : rest.slice(0, end)
  const line = body
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line === undefined ? null : capText(line, 240)
}

function extractPid(head) {
  const match = /shell pid:\s*(\d+)/.exec(String(head ?? ''))
  return match === null ? null : Number(match[1])
}

function logCode(source, detail) {
  if (source === 'renderer' && /oom|out of memory|virtual memory/i.test(detail ?? '')) return 'crash.renderer-oom'
  if (source === 'host') return 'crash.host-exit'
  if (source === 'renderer') return 'crash.renderer'
  if (source === 'main') return 'crash.main'
  if (source === 'web-boot') return 'crash.web-boot'
  return 'crash.other'
}

function logSeverity(code, detail) {
  if (code === 'crash.renderer-oom' || code === 'crash.host-exit') return 'critical'
  if (/virtual memory|memory/i.test(detail ?? '')) return 'critical'
  return 'warn'
}

function readLogs(value, now) {
  const entries = []
  const logs = Array.isArray(value.logs) ? value.logs : []
  for (const log of logs) {
    if (log === null || typeof log !== 'object') continue
    const parsed = parseCrashLogName(log.name)
    const at = finiteOrNull(log.at) ?? parsed?.at ?? null
    if (at === null || at > now) continue
    const source = parsed?.source ?? 'unknown'
    const detail = extractErrorLine(log.head)
    const code = logCode(source, detail)
    entries.push({
      at,
      source: 'dsh-log',
      crashSource: source,
      code,
      severity: logSeverity(code, detail),
      detail,
      pid: extractPid(log.head),
      title: null,
    })
  }
  return entries
}

function readEvents(value) {
  const entries = []
  const events = Array.isArray(value.events) ? value.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const at = finiteOrNull(event.at)
    const id = Number(event.id)
    const code = EVENT_CODES[id]
    if (at === null || code === undefined) continue
    const detail = capText(event.message ?? '', 240)
    entries.push({
      at,
      source: 'windows-event',
      crashSource: null,
      code,
      severity: id === 41 ? 'critical' : 'warn',
      detail: detail.length > 0 ? detail : null,
      pid: null,
      eventId: id,
      title: null,
    })
  }
  return entries
}

function mergeLogGroups(entries) {
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  const merged = []
  for (const entry of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.at - entry.at <= 30000) {
      const sources = new Set(last.sources)
      sources.add(entry.crashSource ?? entry.source)
      last.sources = [...sources]
      last.severity = last.severity === 'critical' || entry.severity === 'critical' ? 'critical' : 'warn'
      const lastRank = CODE_ORDER[last.code] ?? 6
      const entryRank = CODE_ORDER[entry.code] ?? 6
      if (entryRank < lastRank) {
        last.code = entry.code
        last.detail = entry.detail ?? last.detail
        last.crashSource = entry.crashSource
        last.pid = entry.pid ?? last.pid
      }
      continue
    }
    merged.push({ ...entry, sources: [entry.crashSource ?? entry.source] })
  }
  return merged
}

export function parseCrashHistory(value, { now = Date.now(), days = CRASH_HISTORY_DAYS, limit = CRASH_HISTORY_LIMIT } = {}) {
  if (value === null || typeof value !== 'object' || value.ok !== true) {
    return { ok: false, at: now, error: capText(value?.error ?? 'crash history probe returned no data', 300), items: [] }
  }
  const windowStart = now - Math.max(1, days) * 24 * 60 * 60 * 1000
  const logs = mergeLogGroups(readLogs(value, now))
  const events = readEvents(value)
  const items = [...logs, ...events]
    .filter((entry) => entry.at >= windowStart)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, limit))
  return {
    ok: true,
    at: now,
    sampledAt: finiteOrNull(value.ts),
    error: null,
    days: Math.max(1, days),
    limit: Math.max(1, limit),
    logDir: capText(value.logDir ?? '', 260),
    items,
    crashCount: items.filter((entry) => entry.source === 'dsh-log').length,
    eventCount: items.filter((entry) => entry.source === 'windows-event').length,
  }
}

export async function sampleCrashHistory({
  scriptPath,
  days = CRASH_HISTORY_DAYS,
  limit = CRASH_HISTORY_LIMIT,
  env = process.env,
  spawnProcess,
  timeoutMs,
  run = runPowerShellJson,
  now = Date.now,
} = {}) {
  const args = ['-Days', String(days), '-Limit', String(limit)]
  let result
  try {
    result = await run({ script: scriptPath, args, env, spawnProcess, timeoutMs })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const at = now()
  if (result?.ok !== true) {
    return parseCrashHistory({ ok: false, error: result?.error ?? 'crash history probe failed' }, { now: at, days, limit })
  }
  return parseCrashHistory(result.value, { now: at, days, limit })
}
