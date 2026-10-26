import { ATTRIBUTION_MIN_TRACK_BYTES, RESIDENT_NOTICE_MS, RESIDENT_WINDOW_MS } from './constants.js'

export const RESIDENT_DEFAULTS = {
  minBytes: ATTRIBUTION_MIN_TRACK_BYTES,
  windowMs: RESIDENT_WINDOW_MS,
  noticeMs: RESIDENT_NOTICE_MS,
}

export function trackResidents({ tracked = {}, attribution, thresholds = RESIDENT_DEFAULTS } = {}) {
  const empty = { tracked: {}, alerts: [] }
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) return empty
  if (!Array.isArray(attribution.top) || attribution.top.length === 0) return empty
  const at = Number(attribution.at)
  if (!Number.isFinite(at)) return empty
  const minBytes = Number(thresholds.residentMinBytes ?? RESIDENT_DEFAULTS.minBytes)
  const growBytes = Number(thresholds.residentGrowBytes ?? 0)
  const windowMs = Number(thresholds.residentWindowMs ?? RESIDENT_DEFAULTS.windowMs)
  const next = {}
  const alerts = []
  for (const row of attribution.top) {
    const pid = Number(row?.pid)
    const bytes = Number(row?.bytes)
    if (!Number.isFinite(pid) || !Number.isFinite(bytes) || bytes < minBytes) continue
    const previous = tracked[pid]
    if (!previous) {
      next[pid] = { pid, name: row.name ?? '', baseAt: at, baseBytes: bytes }
      continue
    }
    if (bytes < previous.baseBytes) {
      next[pid] = { ...previous, baseAt: at, baseBytes: bytes }
      continue
    }
    const spanMs = at - previous.baseAt
    const growthBytes = bytes - previous.baseBytes
    if (growBytes > 0 && spanMs >= windowMs && growthBytes >= growBytes) {
      alerts.push({
        pid,
        name: row.name ?? '',
        dsh: row.dsh === true,
        bytes,
        growthBytes,
        spanMs,
        ageMin: Number.isFinite(Number(row.ageMin)) ? Number(row.ageMin) : null,
        exePath: typeof row.exePath === 'string' && row.exePath.length > 0 ? row.exePath : null,
        at,
      })
      next[pid] = { ...previous, baseAt: at, baseBytes: bytes }
      continue
    }
    next[pid] = previous
  }
  return { tracked: next, alerts }
}

export function shouldNotifyResident(cooldowns, pid, now, noticeMs = RESIDENT_DEFAULTS.noticeMs) {
  const last = cooldowns[pid] ?? 0
  return now - last >= noticeMs
}
