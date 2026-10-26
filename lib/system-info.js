import { GIB } from './constants.js'
import { runPowerShellJson } from './ps.js'
import { capText } from './util.js'

const MIB = 1024 * 1024

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function toMb(bytes) {
  const value = finiteOrNull(bytes)
  return value === null ? null : Math.round(value / MIB)
}

export function buildPagefileAdvice({
  physicalTotal = null,
  commitLimit = null,
  pagefileTotalBytes = null,
  pagefiles = [],
  automaticManaged = false,
} = {}) {
  const physicalMb = toMb(physicalTotal)
  const pagefileMb = toMb(pagefileTotalBytes) ?? 0
  const headroom = finiteOrNull(commitLimit) !== null && finiteOrNull(physicalTotal) !== null ? commitLimit - physicalTotal : null
  const suggestionMb = physicalMb === null ? 4096 : Math.max(4096, Math.min(32768, Math.round(physicalMb / 4)))
  const advice = []
  if (pagefiles.length === 0 || pagefileMb <= 0) {
    advice.push({ code: 'pagefile.none', severity: 'warn', suggestionMb, pagefileMb, headroomMb: toMb(headroom) })
  } else if (headroom !== null && headroom < 2 * GIB) {
    advice.push({ code: 'pagefile.small', severity: 'warn', suggestionMb, pagefileMb, headroomMb: toMb(headroom) })
  }
  if (physicalMb !== null && physicalMb >= 16 * 1024 && pagefiles.length > 0 && pagefiles.every((entry) => entry.systemVolume === true)) {
    advice.push({ code: 'pagefile.system-volume', severity: 'info', suggestionMb: null, pagefileMb, headroomMb: toMb(headroom) })
  }
  if (advice.length === 0) {
    advice.push({ code: 'pagefile.ok', severity: 'ok', suggestionMb: null, pagefileMb, headroomMb: toMb(headroom) })
  }
  if (automaticManaged === true) {
    advice.push({ code: 'pagefile.automatic', severity: 'info', suggestionMb: null, pagefileMb, headroomMb: toMb(headroom) })
  }
  return advice
}

export function normalizeSystemInfo(value, { at = Date.now() } = {}) {
  if (value === null || typeof value !== 'object' || value.ok !== true) {
    return { ok: false, at, error: capText(value?.error ?? 'system probe returned no data', 300), pagefiles: [], advice: [] }
  }
  const pagefiles = (Array.isArray(value.pagefiles) ? value.pagefiles : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      path: capText(entry.path ?? '', 260),
      currentMb: finiteOrNull(entry.currentMb) ?? 0,
      initialMb: finiteOrNull(entry.initialMb),
      maximumMb: finiteOrNull(entry.maximumMb),
      exists: entry.exists === true,
      systemVolume: entry.systemVolume === true,
    }))
  const pagefileTotalBytes =
    finiteOrNull(value.pagefileTotalBytes) ?? pagefiles.reduce((sum, entry) => sum + entry.currentMb * MIB, 0)
  const physicalTotal = finiteOrNull(value.physicalTotal)
  const commitLimit = finiteOrNull(value.commitLimit)
  const commitUsed = finiteOrNull(value.commitUsed)
  const usedPct = commitLimit !== null && commitLimit > 0 && commitUsed !== null ? Math.round((commitUsed / commitLimit) * 1000) / 10 : null
  return {
    ok: true,
    at,
    sampledAt: finiteOrNull(value.ts),
    error: null,
    systemDrive: capText(value.systemDrive ?? '', 8),
    automaticManaged: value.automaticManaged === true,
    commitUsed,
    commitLimit,
    physicalTotal,
    physicalAvailable: finiteOrNull(value.physicalAvailable),
    pagefileTotalBytes,
    usedPct,
    pagefiles,
    advice: buildPagefileAdvice({
      physicalTotal,
      commitLimit,
      pagefileTotalBytes,
      pagefiles,
      automaticManaged: value.automaticManaged === true,
    }),
  }
}

export async function sampleSystemInfo({
  scriptPath,
  env = process.env,
  spawnProcess,
  timeoutMs,
  run = runPowerShellJson,
  now = Date.now,
} = {}) {
  let result
  try {
    result = await run({ script: scriptPath, args: [], env, spawnProcess, timeoutMs })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const at = now()
  if (result?.ok !== true) {
    return normalizeSystemInfo({ ok: false, error: result?.error ?? 'system probe failed' }, { at })
  }
  return normalizeSystemInfo(result.value, { at })
}
