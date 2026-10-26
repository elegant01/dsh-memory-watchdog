import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  RESUME_ATTEMPT_RESET_MS,
  RESUME_LEDGER_ITEMS,
  RESUME_MAX_ATTEMPTS,
  RESUME_MAX_CHILD_INSPECTS,
  RESUME_QUIET_MS,
  RESUME_WINDOW_MS,
} from './constants.js'
import { resolveDshHome } from './dsh-home.js'
import { capText, safeErrorMessage } from './util.js'

const LOG_FILE_CANDIDATES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const LEDGER_SESSION_LIMIT = 200
const LEDGER_MARK_LIMIT = 500
const SKIPPED_LIMIT = 30

export function tailTurnEndOf(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    return {
      kind: String(event?.data?.reason?.kind ?? ''),
      time: Number(event?.time ?? 0),
      turn: Number(event?.data?.turn ?? -1),
    }
  }
  return undefined
}

export function withinWindow(summary, now, windowMs = RESUME_WINDOW_MS) {
  const updatedAt = Number(summary?.updatedAt ?? 0)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  return now - updatedAt <= windowMs
}

export function requestIdFor(sessionId, turn, cause = 'self') {
  const suffix = cause === 'child' ? '-child' : ''
  return `commit-guard-resume-${sessionId}-${turn}${suffix}`
}

export function buildPromptText(turn) {
  return [
    '[Automatic resume - DSH process restart]',
    '',
    `The previous turn (turn ${turn}) was interrupted by a DSH process restart and never finished normally.`,
    '',
    'Continue as follows:',
    '1. First verify the real current state (workspace files, git status, background jobs and subprocesses, external actions already performed) to determine what actually completed before the interruption.',
    '2. Resume the original task from the interruption point.',
    '3. Do not repeat actions that may already have had side effects (writing files, committing, pushing, deleting, publishing, deploying). If you cannot confirm whether one ran, verify before acting.',
    '4. If the state is still unclear after checking, stop and report what you found.',
    '',
    'This message was injected automatically by a plugin; it is not a new request.',
  ].join('\n')
}

function emptyLedger() {
  return { version: 1, sessions: {}, childHandled: {}, unsupported: {} }
}

function objectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalizeResumeLedger(value) {
  if (value === null || typeof value !== 'object') return emptyLedger()
  const ledger = emptyLedger()
  for (const [sessionId, entry] of Object.entries(objectMap(value.sessions))) {
    if (entry === null || typeof entry !== 'object') continue
    const attempts = Number(entry.attempts)
    if (!Number.isFinite(attempts) || attempts < 0) continue
    ledger.sessions[sessionId] = {
      attempts: Math.round(attempts),
      lastTurn: Number.isFinite(Number(entry.lastTurn)) ? Number(entry.lastTurn) : -1,
      lastCause: entry.lastCause === 'child' ? 'child' : 'self',
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
      lastKind: typeof entry.lastKind === 'string' ? entry.lastKind : null,
    }
  }
  for (const key of Object.keys(objectMap(value.childHandled))) ledger.childHandled[key] = true
  for (const key of Object.keys(objectMap(value.unsupported))) ledger.unsupported[key] = true
  return ledger
}

function pruneObject(map, limit) {
  const keys = Object.keys(map)
  if (keys.length <= limit) return map
  const pruned = {}
  for (const key of keys.slice(keys.length - limit)) pruned[key] = map[key]
  return pruned
}

function pruneLedger(ledger, now) {
  const entries = Object.entries(ledger.sessions)
    .filter(([, entry]) => entry.at === 0 || now - entry.at < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, LEDGER_SESSION_LIMIT)
  ledger.sessions = Object.fromEntries(entries)
  ledger.childHandled = pruneObject(ledger.childHandled, LEDGER_MARK_LIMIT)
  ledger.unsupported = pruneObject(ledger.unsupported, LEDGER_MARK_LIMIT)
  return ledger
}

export function sessionsRoot(env = process.env) {
  return join(resolveDshHome(undefined, env), 'sessions')
}

export function findSessionLog(sessionId, { env = process.env } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || !SESSION_ID_PATTERN.test(sessionId)) return undefined
  const root = sessionsRoot(env)
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const directory = join(root, workspace.name, sessionId)
    for (const name of LOG_FILE_CANDIDATES) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export function sessionLogMtimeMs(sessionId, { env = process.env } = {}) {
  const file = findSessionLog(sessionId, { env })
  if (file === undefined) return 0
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export class ResumeManager {
  constructor({
    ctx,
    env = process.env,
    now = Date.now,
    enabled = false,
    ledger = null,
    persist = async () => {},
    quietMs = RESUME_QUIET_MS,
    windowMs = RESUME_WINDOW_MS,
    maxAttempts = RESUME_MAX_ATTEMPTS,
    attemptResetMs = RESUME_ATTEMPT_RESET_MS,
    maxChildInspects = RESUME_MAX_CHILD_INSPECTS,
    controller = null,
    logMtime = (sessionId) => sessionLogMtimeMs(sessionId, { env }),
    buildPrompt = buildPromptText,
  } = {}) {
    this.ctx = ctx
    this.env = env
    this.now = now
    this.enabled = enabled === true
    this.ledger = normalizeResumeLedger(ledger)
    this.persist = persist
    this.quietMs = quietMs
    this.windowMs = windowMs
    this.maxAttempts = maxAttempts
    this.attemptResetMs = attemptResetMs
    this.maxChildInspects = maxChildInspects
    this.controller = controller
    this.logMtime = logMtime
    this.buildPrompt = buildPrompt
    this.lastScanAt = null
    this.lastScan = null
    this.scanning = null
  }

  setEnabled(enabled) {
    this.enabled = enabled === true
  }

  setLedger(ledger) {
    this.ledger = normalizeResumeLedger(ledger)
  }

  controllerOf() {
    if (this.controller !== null) return this.controller
    try {
      return typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined
    } catch {
      return undefined
    }
  }

  async writeLedger() {
    pruneLedger(this.ledger, this.now())
    await this.persist(this.ledger)
  }

  state() {
    const sessions = Object.entries(this.ledger.sessions)
      .map(([sessionId, entry]) => ({
        sessionId,
        attempts: entry.attempts,
        lastTurn: entry.lastTurn,
        lastCause: entry.lastCause,
        at: entry.at,
        lastKind: entry.lastKind,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, RESUME_LEDGER_ITEMS)
    return {
      enabled: this.enabled,
      scanning: this.scanning !== null,
      lastScanAt: this.lastScanAt,
      lastScan: this.lastScan,
      ledger: sessions,
      quietMs: this.quietMs,
      windowMs: this.windowMs,
      maxAttempts: this.maxAttempts,
    }
  }

  scanNow({ dryRun = false } = {}) {
    if (this.scanning !== null) return this.scanning
    this.scanning = this.scan({ dryRun }).finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  async scan({ dryRun = false } = {}) {
    const at = this.now()
    const summary = {
      ok: false,
      at,
      dryRun,
      total: 0,
      candidates: 0,
      resumed: 0,
      actions: [],
      skipped: [],
      deferred: [],
      nextDueAt: null,
      error: null,
      code: null,
    }
    const controller = this.controllerOf()
    if (
      controller === undefined ||
      controller === null ||
      typeof controller.list !== 'function' ||
      typeof controller.inspect !== 'function' ||
      typeof controller.prompt !== 'function'
    ) {
      summary.code = 'resume.no-controller'
      summary.error = 'the sessionController service is unavailable'
      this.lastScanAt = at
      this.lastScan = summary
      return summary
    }
    const signal = new AbortController().signal
    let items
    try {
      const listed = await controller.list({}, signal)
      items = Array.isArray(listed?.items) ? listed.items : []
    } catch (error) {
      summary.code = 'resume.list-failed'
      summary.error = safeErrorMessage(error)
      this.lastScanAt = at
      this.lastScan = summary
      return summary
    }
    summary.ok = true
    summary.total = items.length

    const children = await this.collectInterruptedChildren({ controller, items, at, summary, dryRun })

    for (const entry of items) {
      await this.planSession({ controller, entry, at, summary, children, dryRun, signal })
    }

    summary.nextDueAt =
      summary.deferred.length === 0 ? null : Math.min(...summary.deferred.map((item) => item.dueAt))
    this.lastScanAt = at
    const stored = {
      ...summary,
      actions: summary.actions.slice(0, RESUME_LEDGER_ITEMS),
      skipped: summary.skipped.slice(0, SKIPPED_LIMIT),
      deferred: summary.deferred.slice(0, RESUME_LEDGER_ITEMS),
    }
    this.lastScan = stored
    return summary
  }

  async collectInterruptedChildren({ controller, items, at, summary, dryRun }) {
    const parentsWithOpenChild = new Set()
    const childInterruptedAt = new Map()
    const childrenByParent = new Map()
    const { unsupported, childHandled } = this.ledger
    let inspects = 0
    let failures = 0
    for (const entry of items) {
      if (entry?.parentSessionId === undefined || entry?.parentSessionId === null) continue
      const childId = String(entry?.sessionId ?? '')
      if (childId.length === 0 || unsupported[childId] === true) continue
      if (inspects >= this.maxChildInspects) break
      const mtime = this.logMtime(childId)
      if (!Number.isFinite(mtime) || mtime <= 0) continue
      if (at - mtime > this.windowMs) continue
      inspects += 1
      try {
        const observed = await controller.inspect(childId)
        const tail = tailTurnEndOf(observed?.events)
        if (tail === undefined || tail.kind !== 'interrupted' || childHandled[childId] === true) continue
        const parentId = String(entry.parentSessionId)
        parentsWithOpenChild.add(parentId)
        const bucket = childrenByParent.get(parentId)
        if (bucket === undefined) childrenByParent.set(parentId, [childId])
        else bucket.push(childId)
        childInterruptedAt.set(parentId, Math.max(childInterruptedAt.get(parentId) ?? 0, tail.time || 0))
      } catch {
        failures += 1
        unsupported[childId] = true
      }
    }
    if (failures > 0 && !dryRun) await this.writeLedger()
    return { parentsWithOpenChild, childInterruptedAt, childrenByParent }
  }

  skip(summary, sessionId, code, extra = {}) {
    summary.skipped.push({ sessionId, code, ...extra })
  }

  async planSession({ controller, entry, at, summary, children, dryRun, signal }) {
    const sessionId = String(entry?.sessionId ?? '')
    if (sessionId.length === 0) return
    if (entry?.origin === 'subagent' || (entry?.parentSessionId !== undefined && entry?.parentSessionId !== null)) return
    if (entry?.blank === true) return
    if (!withinWindow(entry, at, this.windowMs)) return
    if (entry?.running === true) {
      this.skip(summary, sessionId, 'resume.running')
      return
    }
    summary.candidates += 1
    let observed
    try {
      observed = await controller.inspect(sessionId)
    } catch (error) {
      this.skip(summary, sessionId, 'resume.inspect-failed', { error: capText(safeErrorMessage(error), 120) })
      return
    }
    const tail = tailTurnEndOf(observed?.events)
    if (tail === undefined) {
      this.skip(summary, sessionId, 'resume.no-turn-end')
      return
    }
    if (tail.kind === 'aborted') {
      this.skip(summary, sessionId, 'resume.user-canceled', { turn: tail.turn })
      return
    }
    const hasOpenChild = children.parentsWithOpenChild.has(sessionId)
    if (tail.kind !== 'interrupted' && !hasOpenChild) return
    const cause = tail.kind === 'interrupted' ? 'self' : 'child'

    const ownAt = tail.kind === 'interrupted' && tail.time > 0 ? tail.time : 0
    const childAt = children.childInterruptedAt.get(sessionId) ?? 0
    let interruptedAt = Math.max(ownAt, childAt)
    if (interruptedAt <= 0) interruptedAt = Number(entry?.updatedAt ?? 0)
    if (interruptedAt > 0 && at - interruptedAt < this.quietMs) {
      const dueAt = interruptedAt + this.quietMs
      summary.deferred.push({ sessionId, dueAt })
      this.skip(summary, sessionId, 'resume.quiet-period', { dueAt, turn: tail.turn })
      return
    }

    let record = this.ledger.sessions[sessionId] ?? { attempts: 0, lastTurn: -1, lastCause: 'self', at: 0, lastKind: null }
    if (record.attempts > 0 && record.at > 0 && at - record.at > this.attemptResetMs) {
      record = { attempts: 0, lastTurn: -1, lastCause: 'self', at: 0, lastKind: null }
      this.ledger.sessions[sessionId] = record
    }
    if (record.attempts >= this.maxAttempts) {
      this.skip(summary, sessionId, 'resume.attempt-limit', { attempts: record.attempts, turn: tail.turn })
      return
    }
    if (record.attempts > 0 && record.lastTurn === tail.turn && (record.lastCause ?? 'self') === cause) {
      this.skip(summary, sessionId, 'resume.already-handled', { turn: tail.turn, cause })
      return
    }

    const requestId = requestIdFor(sessionId, tail.turn, cause)
    if (dryRun) {
      summary.actions.push({ sessionId, turn: tail.turn, cause, status: 'dry-run' })
      return
    }

    const triggeringChildren = children.childrenByParent.get(sessionId) ?? []
    this.ledger.sessions[sessionId] = {
      attempts: record.attempts + 1,
      lastTurn: tail.turn,
      lastCause: cause,
      at,
      lastKind: tail.kind,
    }
    for (const childId of triggeringChildren) this.ledger.childHandled[childId] = true
    await this.writeLedger()
    try {
      await controller.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: this.buildPrompt(tail.turn) }],
        },
        signal,
      )
      summary.resumed += 1
      summary.actions.push({ sessionId, turn: tail.turn, cause, status: 'prompted' })
    } catch (error) {
      summary.actions.push({
        sessionId,
        turn: tail.turn,
        cause,
        status: 'failed',
        error: capText(safeErrorMessage(error), 160),
      })
    }
  }
}
