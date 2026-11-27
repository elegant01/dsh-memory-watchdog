import { INCIDENT_ATTRIBUTION_FRESH_MS, INCIDENT_TOP_GROUPS } from './constants.js'

/**
 * A pressure transition used to leave only a percentage behind: by the time
 * someone opened the card, the process that caused the spike was long gone from
 * the live attribution list. An incident freezes the program ranking that was
 * visible at the moment of the transition, plus how old that sample was.
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function intOrNull(value) {
  const number = finite(value)
  return number === null ? null : Math.round(number)
}

function summarizeGroups(groups, topGroups) {
  if (!Array.isArray(groups)) return []
  return groups
    .filter((group) => group !== null && typeof group === 'object')
    .map((group) => ({
      name: typeof group.name === 'string' && group.name.length > 0 ? group.name : 'unknown',
      count: intOrNull(group.count),
      bytes: intOrNull(group.bytes),
      dsh: group.dsh === true,
      dshBytes: intOrNull(group.dshBytes),
    }))
    .filter((group) => group.bytes !== null && group.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, topGroups)
}

export function summarizeAttribution(
  attribution,
  at = Date.now(),
  { freshMs = INCIDENT_ATTRIBUTION_FRESH_MS, topGroups = INCIDENT_TOP_GROUPS } = {},
) {
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) {
    return { state: 'missing', attribution: null }
  }
  const sampledAt = finite(attribution.at)
  if (sampledAt === null) return { state: 'missing', attribution: null }
  const ageMs = Math.max(0, at - sampledAt)
  return {
    state: ageMs <= freshMs ? 'fresh' : 'stale',
    attribution: {
      at: sampledAt,
      ageMs,
      sharePct: finite(attribution.sharePct),
      dshBytes: finite(attribution.dshBytes),
      dshCount: intOrNull(attribution.dshCount),
      groups: summarizeGroups(attribution.groups, topGroups),
    },
  }
}

export function createIncident({ id, transition, sample, attribution, at = Date.now(), topGroups = INCIDENT_TOP_GROUPS } = {}) {
  const used = finite(sample?.commitUsed)
  const limit = finite(sample?.commitLimit)
  const pct = used !== null && limit !== null && limit > 0 ? Math.round((used / limit) * 1000) / 10 : null
  const summary = summarizeAttribution(attribution, at, { topGroups })
  return {
    version: 1,
    id: typeof id === 'string' && id.length > 0 ? id : `${at}-${String(transition?.to ?? 'unknown')}`,
    at,
    from: typeof transition?.from === 'string' ? transition.from : null,
    to: typeof transition?.to === 'string' ? transition.to : null,
    episodeId: typeof transition?.episodeId === 'string' ? transition.episodeId : null,
    pct,
    used,
    limit,
    available: used !== null && limit !== null ? Math.max(0, limit - used) : null,
    attribution: summary.attribution,
    attributionState: summary.state,
    attributionFilledAt: null,
  }
}

export function normalizeIncidents(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []
  return items
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      version: 1,
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : String(entry.at ?? ''),
      at: finite(entry.at),
      from: typeof entry.from === 'string' ? entry.from : null,
      to: typeof entry.to === 'string' ? entry.to : null,
      episodeId: typeof entry.episodeId === 'string' ? entry.episodeId : null,
      pct: finite(entry.pct),
      used: finite(entry.used),
      limit: finite(entry.limit),
      available: finite(entry.available),
      attribution:
        entry.attribution !== null && typeof entry.attribution === 'object'
          ? {
              at: finite(entry.attribution.at),
              ageMs: finite(entry.attribution.ageMs),
              sharePct: finite(entry.attribution.sharePct),
              dshBytes: finite(entry.attribution.dshBytes),
              dshCount: intOrNull(entry.attribution.dshCount),
              groups: summarizeGroups(entry.attribution.groups, INCIDENT_TOP_GROUPS),
            }
          : null,
      attributionState: typeof entry.attributionState === 'string' ? entry.attributionState : 'missing',
      attributionFilledAt: finite(entry.attributionFilledAt),
    }))
    .filter((entry) => entry.at !== null)
}
