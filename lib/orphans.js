import { ORPHAN_MAX_ITEMS, ORPHAN_STALE_MS } from './constants.js'
import { PROTECTED_PROCESS_NAMES, processBaseName } from './process-kill.js'

/**
 * Leftover DSH processes are found by the PowerShell probe, but every value that
 * reaches the panel or the kill plan passes through here first. The kill path
 * only accepts a pid that exists in the cached scan, and the helper re-checks
 * the pid, image name, exact creation time and tree membership before stopping
 * anything — a recycled pid or a process that joined the current tree in the
 * meantime is refused instead of guessed at.
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function intOrNull(value) {
  const number = finite(value)
  return number === null ? null : Math.round(number)
}

function textOrNull(value, max = 260) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length === 0 ? null : text.slice(0, max)
}

function normalizeItem(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const pid = intOrNull(entry.pid)
  const bytes = intOrNull(entry.bytes)
  const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : finite(entry.createdAt) === null ? null : String(entry.createdAt)
  const item = {
    pid,
    parentPid: intOrNull(entry.parentPid),
    name: textOrNull(entry.name, 80) ?? 'unknown',
    bytes,
    ageMin: intOrNull(entry.ageMin),
    exePath: textOrNull(entry.exePath),
    createdAt,
    startedAt: finite(entry.startedAt),
  }
  if (item.pid === null || item.pid <= 4) return null
  if (item.exePath === null || item.createdAt === null) return null
  return item
}

export function normalizeOrphanScan(value, { at = Date.now(), maxItems = ORPHAN_MAX_ITEMS } = {}) {
  if (value === null || typeof value !== 'object' || value.ok !== true) {
    return {
      ok: false,
      at,
      error: typeof value?.error === 'string' ? value.error.slice(0, 300) : 'orphan scan returned no data',
      rootPath: null,
      hostStartedAt: null,
      scanned: null,
      items: [],
    }
  }
  const items = (Array.isArray(value.items) ? value.items : [])
    .map(normalizeItem)
    .filter((entry) => entry !== null)
    .sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0))
    .slice(0, maxItems)
  return {
    ok: true,
    at,
    error: null,
    rootPath: textOrNull(value.rootPath),
    hostStartedAt: finite(value.hostStartedAt),
    scanned: intOrNull(value.scanned),
    items,
  }
}

export function orphanScanStale(scan, now = Date.now(), maxAgeMs = ORPHAN_STALE_MS) {
  if (scan === null || typeof scan !== 'object' || scan.ok !== true) return true
  return !Number.isFinite(scan.at) || now - scan.at > maxAgeMs
}

export function findOrphan(scan, pid, now = Date.now(), maxAgeMs = ORPHAN_STALE_MS) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 4) {
    return { ok: false, code: 'invalid-pid', error: 'pid must be an integer greater than 4' }
  }
  if (scan === null || typeof scan !== 'object' || scan.ok !== true) {
    return { ok: false, code: 'no-orphans', error: 'no orphan scan has completed yet' }
  }
  if (!Number.isFinite(scan.at) || now - scan.at > maxAgeMs) {
    return { ok: false, code: 'stale-orphans', error: 'the orphan scan is too old' }
  }
  const item = (Array.isArray(scan.items) ? scan.items : []).find((entry) => entry?.pid === pid)
  if (item === undefined) {
    return { ok: false, code: 'unknown-orphan', error: 'pid is not in the last orphan scan' }
  }
  return { ok: true, ...item }
}

export function guardOrphanTarget(target, { hostPid = null } = {}) {
  if (target?.ok !== true) return target
  if (hostPid !== null && target.pid === hostPid) {
    return { ok: false, code: 'protected-process', error: 'this is the host process' }
  }
  if (PROTECTED_PROCESS_NAMES.has(processBaseName(target.name))) {
    return { ok: false, code: 'protected-process', error: 'critical Windows process' }
  }
  if (typeof target.exePath !== 'string' || target.exePath.length === 0) {
    return { ok: false, code: 'invalid-orphan', error: 'the scan did not record an executable path' }
  }
  if (typeof target.createdAt !== 'string' || target.createdAt.length === 0) {
    return { ok: false, code: 'invalid-orphan', error: 'the scan did not record a creation time' }
  }
  return target
}

export function orphanKillStatus(result) {
  if (result?.ok === true) return 200
  switch (result?.code) {
    case 'invalid-pid':
    case 'invalid-orphan':
      return 400
    case 'protected-process':
      return 403
    case 'no-orphans':
    case 'stale-orphans':
    case 'unknown-orphan':
    case 'nothing-killed':
    case 'not-found':
    case 'name-mismatch':
    case 'creation-mismatch':
    case 'outside-root':
    case 'in-current-tree':
      return 409
    default:
      return 503
  }
}
