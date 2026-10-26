import { ATTRIBUTION_MAX_AGE_MS, ATTRIBUTION_TOP_N, RESTART_GATE_MIN_SHARE_PCT } from './constants.js'
import { runPowerShellJson } from './ps.js'
import { capText } from './util.js'

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function intOr(value, fallback = null) {
  const number = finiteOrNull(value)
  return number === null ? fallback : Math.round(number)
}

function normalizeTop(entries, topN) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      pid: intOr(entry.pid),
      parentPid: intOr(entry.parentPid),
      name: capText(entry.name ?? 'unknown', 80),
      bytes: intOr(entry.bytes, 0),
      dsh: entry.dsh === true,
      exePath: typeof entry.exePath === 'string' && entry.exePath.length > 0 ? capText(entry.exePath, 260) : null,
      ageMin: Number.isFinite(Number(entry.ageMin)) ? Math.max(0, Math.round(Number(entry.ageMin))) : null,
    }))
    .filter((entry) => entry.pid !== null && entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topN)
}

export function normalizeAttribution(value, { at = Date.now(), topN = ATTRIBUTION_TOP_N } = {}) {
  if (value === null || typeof value !== 'object' || value.ok !== true) {
    return {
      ok: false,
      at,
      sampledAt: null,
      error: capText(value?.error ?? 'attribution probe returned no data', 300),
      systemCommitUsed: null,
      systemCommitLimit: null,
      dshBytes: null,
      dshCount: null,
      sharePct: null,
      top: [],
    }
  }
  const systemCommitUsed = finiteOrNull(value.systemCommitUsed)
  const dshBytes = finiteOrNull(value.dsh?.bytes)
  const sharePct =
    systemCommitUsed !== null && systemCommitUsed > 0 && dshBytes !== null
      ? Math.round((dshBytes / systemCommitUsed) * 1000) / 10
      : null
  return {
    ok: systemCommitUsed !== null && dshBytes !== null,
    at,
    sampledAt: finiteOrNull(value.ts),
    error: null,
    systemCommitUsed,
    systemCommitLimit: finiteOrNull(value.systemCommitLimit),
    dshBytes,
    dshCount: intOr(value.dsh?.count),
    sharePct,
    top: normalizeTop(value.top, topN),
    scanned: intOr(value.scanned),
    accessible: intOr(value.accessible),
  }
}

export function attributionFresh(attribution, now = Date.now(), maxAgeMs = ATTRIBUTION_MAX_AGE_MS) {
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) return false
  const at = finiteOrNull(attribution.at)
  return at !== null && now - at <= maxAgeMs
}

export function evaluateRestartGate({ attribution, gatePct = RESTART_GATE_MIN_SHARE_PCT, now = Date.now() } = {}) {
  const ratio = Math.max(0, Math.min(100, Number.isFinite(gatePct) ? gatePct : RESTART_GATE_MIN_SHARE_PCT))
  const sharePct = finiteOrNull(attribution?.sharePct)
  const base = { gatePct: ratio, sharePct }
  if (ratio === 0) return { ...base, allowed: true, code: 'gate.disabled' }
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) {
    return { ...base, allowed: false, code: 'gate.unavailable' }
  }
  if (!attributionFresh(attribution, now)) return { ...base, allowed: false, code: 'gate.stale' }
  if (sharePct === null || sharePct < ratio) return { ...base, allowed: false, code: 'gate.share-below' }
  return { ...base, allowed: true, code: 'gate.passed' }
}

export async function sampleAttribution({
  scriptPath,
  hostPid,
  mainPid = 0,
  topN = ATTRIBUTION_TOP_N,
  env = process.env,
  spawnProcess,
  timeoutMs,
  run = runPowerShellJson,
  now = Date.now,
} = {}) {
  const args = ['-HostPid', String(hostPid ?? 0), '-MainPid', String(mainPid ?? 0), '-TopN', String(topN)]
  let result
  try {
    result = await run({ script: scriptPath, args, env, spawnProcess, timeoutMs })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const at = now()
  if (result?.ok !== true) {
    return normalizeAttribution({ ok: false, error: result?.error ?? 'attribution probe failed' }, { at, topN })
  }
  return normalizeAttribution(result.value, { at, topN })
}
