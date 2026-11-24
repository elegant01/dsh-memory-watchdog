import { ATTRIBUTION_MAX_AGE_MS } from './constants.js'

// Killing a Windows process is irreversible, so the allowed set is the last
// attribution snapshot the panel already showed. Nothing outside that list can
// be targeted, which keeps a stale page or a hand-written request from turning
// this endpoint into "kill any pid".
export const PROTECTED_PROCESS_NAMES = new Set([
  'system',
  'registry',
  'idle',
  'memory compression',
  'secure system',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'svchost',
  'explorer',
  'dwm',
  'fontdrvhost',
  'sihost',
  'taskhostw',
  'ctfmon',
  'spoolsv',
  'audiodg',
  'conhost',
  'dllhost',
  'runtimebroker',
  'applicationframehost',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'searchhost',
  'searchapp',
  'textinputhost',
  'wudfhost',
  'wmiprvse',
  'lockapp',
  'logonui',
  'userinit',
  'msmpeng',
  'nissrv',
  'securityhealthservice',
  'securityhealthsystray',
  'mpdefendercoreservice',
  'smartscreen',
  'wuauclt',
  'musnotification',
  'smartscreen',
])

export function processBaseName(name) {
  const text = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return text.endsWith('.exe') ? text.slice(0, -4) : text
}

/**
 * Resolve a pid against the last attribution sample. Only pids the panel could
 * have rendered resolve; anything else is rejected as unknown.
 */
export function findKillTarget(attribution, pid, now = Date.now(), maxAgeMs = ATTRIBUTION_MAX_AGE_MS) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 4) {
    return { ok: false, code: 'invalid-pid', error: 'pid must be an integer greater than 4' }
  }
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) {
    return { ok: false, code: 'no-attribution', error: 'attribution has not been sampled yet' }
  }
  if (!Number.isFinite(attribution.at) || now - attribution.at > maxAgeMs) {
    return { ok: false, code: 'stale-attribution', error: 'attribution sample is too old' }
  }
  const groups = Array.isArray(attribution.groups) ? attribution.groups : []
  for (const group of groups) {
    const members = Array.isArray(group?.members) ? group.members : []
    const member = members.find((entry) => entry?.pid === pid)
    if (member !== undefined) {
      return {
        ok: true,
        pid,
        name: typeof group.name === 'string' && group.name.length > 0 ? group.name : 'unknown',
        bytes: Number.isFinite(member.bytes) ? member.bytes : 0,
        dsh: member.dsh === true,
      }
    }
  }
  const top = Array.isArray(attribution.top) ? attribution.top : []
  const row = top.find((entry) => entry?.pid === pid)
  if (row !== undefined) {
    return {
      ok: true,
      pid,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'unknown',
      bytes: Number.isFinite(row.bytes) ? row.bytes : 0,
      dsh: row.dsh === true,
    }
  }
  return { ok: false, code: 'unknown-pid', error: 'pid is not part of the current attribution list' }
}

export function guardKillTarget(target, { hostPid = null } = {}) {
  if (target?.ok !== true) return target
  if (target.dsh === true) {
    return { ok: false, code: 'dsh-process', error: 'DSH processes are never killed from the panel' }
  }
  if (hostPid !== null && target.pid === hostPid) {
    return { ok: false, code: 'protected-process', error: 'this is the host process' }
  }
  if (PROTECTED_PROCESS_NAMES.has(processBaseName(target.name))) {
    return { ok: false, code: 'protected-process', error: 'critical Windows process' }
  }
  return target
}

/**
 * Whole-program kill: every member of one group in a fresh attribution sample.
 * A group that contains a single DSH member is refused as a whole — killing
 * "node.exe" because DSH happens to run one would take the host down.
 */
export function findKillGroup(attribution, name, now = Date.now(), maxAgeMs = ATTRIBUTION_MAX_AGE_MS) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, code: 'invalid-name', error: 'name must be a non-empty string' }
  }
  if (attribution === null || typeof attribution !== 'object' || attribution.ok !== true) {
    return { ok: false, code: 'no-attribution', error: 'attribution has not been sampled yet' }
  }
  if (!Number.isFinite(attribution.at) || now - attribution.at > maxAgeMs) {
    return { ok: false, code: 'stale-attribution', error: 'attribution sample is too old' }
  }
  const groups = Array.isArray(attribution.groups) ? attribution.groups : []
  const group = groups.find((entry) => entry?.name === name)
  if (group === undefined) {
    return { ok: false, code: 'unknown-name', error: 'program is not part of the current attribution list' }
  }
  return {
    ok: true,
    name,
    count: Number.isFinite(group.count) ? group.count : Array.isArray(group.members) ? group.members.length : 0,
    bytes: Number.isFinite(group.bytes) ? group.bytes : 0,
    dsh: group.dsh === true,
    dshBytes: Number.isFinite(group.dshBytes) ? group.dshBytes : 0,
    members: (Array.isArray(group.members) ? group.members : [])
      .filter((member) => member !== null && typeof member === 'object' && Number.isInteger(member.pid) && member.pid > 4)
      .map((member) => ({ pid: member.pid, bytes: Number.isFinite(member.bytes) ? member.bytes : 0, dsh: member.dsh === true })),
  }
}

export function guardKillGroup(target, { hostPid = null } = {}) {
  if (target?.ok !== true) return target
  if (target.dsh === true || target.members.some((member) => member.dsh === true)) {
    return { ok: false, code: 'dsh-process', error: 'this program owns DSH processes' }
  }
  if (PROTECTED_PROCESS_NAMES.has(processBaseName(target.name))) {
    return { ok: false, code: 'protected-process', error: 'critical Windows process' }
  }
  if (hostPid !== null && target.members.some((member) => member.pid === hostPid)) {
    return { ok: false, code: 'protected-process', error: 'this program contains the host process' }
  }
  if (target.members.length === 0) {
    return { ok: false, code: 'unknown-name', error: 'no live pids were resolved for this program' }
  }
  if (target.count > target.members.length) {
    return { ok: false, code: 'group-truncated', error: 'the process list for this program is incomplete' }
  }
  return target
}

export function killResultStatus(result) {
  if (result?.ok === true) return 200
  switch (result?.code) {
    case 'invalid-pid':
    case 'invalid-name':
      return 400
    case 'dsh-process':
    case 'protected-process':
      return 403
    case 'no-attribution':
    case 'stale-attribution':
    case 'unknown-pid':
    case 'unknown-name':
    case 'group-truncated':
    case 'not-found':
    case 'name-mismatch':
      return 409
    default:
      return 503
  }
}
