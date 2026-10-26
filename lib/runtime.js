import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTRIBUTION_REFRESH_MS,
  ATTRIBUTION_TOP_N,
  CRASH_HISTORY_DAYS,
  CRASH_HISTORY_LIMIT,
  CRASH_HISTORY_REFRESH_MS,
  HANDOFF_FROZEN_TIMEOUT_MS,
  HISTORY_STATUS_ITEMS,
  IDLE_CONFIRM_CHECKS,
  IDLE_GRACE_MS,
  NOTICE_LIMIT,
  PLUGIN_VERSION,
  RESUME_SCAN_DELAYS_MS,
  STALE_AFTER_MS,
  SYSTEM_INFO_REFRESH_MS,
  WAITING_REMINDER_MS,
} from './constants.js'
import { configSnapshot, readAutoRestart, readResumeAfterCrash } from './config.js'
import { resolveThresholds } from './thresholds.js'
import { evaluateRestartGate, normalizeAttribution, sampleAttribution } from './attribution.js'
import { shouldNotifyResident, trackResidents } from './resident-watch.js'
import { normalizeSystemInfo, sampleSystemInfo } from './system-info.js'
import { parseCrashHistory, sampleCrashHistory } from './crash-history.js'
import { ResumeManager } from './resume.js'
import { guardDirectory } from './dsh-home.js'
import { HandoffManager } from './handoff.js'
import { inspectActivity } from './activity.js'
import { safeErrorMessage } from './util.js'
import { PressureMachine } from './pressure.js'
import { CollectorSupervisor } from './collector.js'
import { powerShellAvailable } from './ps.js'
import { GuardStore } from './store.js'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const resourcesDir = join(runtimeDir, 'resources')

function nowMs() {
  return Date.now()
}

export class GuardRuntime {
  constructor({
    ctx,
    rawConfig,
    deps = {},
    now = nowMs,
    env = process.env,
    version = PLUGIN_VERSION,
    processRef = process,
    supported,
    platform = process.platform,
    arch = process.arch,
    sessionId = randomUUID(),
  }) {
    this.ctx = ctx
    this.rawConfig = rawConfig
    this.deps = deps
    this.now = now
    this.env = env
    this.version = version
    this.processRef = processRef
    this.platform = platform
    this.arch = arch
    this.sessionId = sessionId
    this.platformReason =
      platform !== 'win32'
        ? 'DSH Memory Guard requires Windows'
        : arch !== 'x64'
          ? 'DSH Memory Guard requires 64-bit Windows'
          : !powerShellAvailable(env)
            ? 'Windows PowerShell was not found'
            : null
    this.supported = supported ?? this.platformReason === null
    this.guardDir = deps.guardDir ?? guardDirectory(env)
    this.startedAt = now()
    this.disposed = false
    this.ticking = false
    this.tickTimer = null
    this.connectTimer = null
    this.thresholds = resolveThresholds(rawConfig)
    this.machine = new PressureMachine({ now, thresholds: this.thresholds })
    this.lastSample = null
    this.lastSampleReceivedAt = null
    this.pending = null
    this.attemptedEpisodeId = null
    this.canceledEpisodeId = null
    this.cancelRequested = false
    this.cooldownUntil = 0
    this.action = { state: 'observing', since: this.startedAt, code: 'action.observing', detail: null }
    this.notices = []
    this.noticeSerial = 0
    this.errorNoticeAt = new Map()
    this.lastActivity = null
    this.lastError = null
    this.capability = { state: 'checking', ok: false, reason: null, checkedAt: null }
    this.capabilityRun = null
    this.handoffActive = false
    this.handoffStarted = false
    this.disconnectScheduled = false
    this.lastRestartRefreshAt = 0
    this.collector = null
    this.handoff = null
    this.store = null
    this.started = false
    this.probesDisabled = deps.probesDisabled === true
    this.attribution = null
    this.attributionRun = null
    this.residentTracked = {}
    this.residentCooldown = {}
    this.residentAlerts = []
    this.systemInfo = null
    this.systemInfoRun = null
    this.crashHistory = null
    this.crashHistoryRun = null
    this.mainPid = null
    this.resume = null
    this.resumeTimer = null
    this.resumeScanIndex = 0
  }

  autoRestartEnabled() {
    return readAutoRestart(this.rawConfig)
  }

  resumeEnabled() {
    return readResumeAfterCrash(this.rawConfig)
  }

  notice(code, params = {}, severity = 'info') {
    const item = { id: ++this.noticeSerial, at: this.now(), code, params, severity }
    this.notices.push(item)
    if (this.notices.length > NOTICE_LIMIT) this.notices.splice(0, this.notices.length - NOTICE_LIMIT)
    return item
  }

  noticeError(code, params = {}) {
    const at = this.now()
    const last = this.errorNoticeAt.get(code) ?? 0
    if (at - last < WAITING_REMINDER_MS) return null
    this.errorNoticeAt.set(code, at)
    return this.notice(code, params, 'error')
  }

  setAction(state, code = null, detail = null) {
    if (this.action.state !== state) this.action.since = this.now()
    this.action = { state, since: this.action.since, code: code ?? `action.${state}`, detail }
  }

  setError(source, message) {
    this.lastError = { at: this.now(), source, message }
  }

  async start() {
    if (this.started) return this
    this.started = true
    this.store = this.deps.store ?? new GuardStore({ dir: this.guardDir, now: this.now })
    const loaded = await this.store.load()
    if (loaded.errors.length > 0) {
      this.setError('store', loaded.errors.map((entry) => `${entry.file}: ${entry.error}`).join('; '))
    }
    this.cooldownUntil = this.store.state.cooldownUntil
    this.handoff =
      this.deps.handoff ??
      new HandoffManager({
        guardDir: this.guardDir,
        helperPath: join(resourcesDir, 'helper.mjs'),
        inspectScript: join(resourcesDir, 'inspect.ps1'),
        runJson: this.deps.runJson ?? ((options) => import('./ps.js').then((ps) => ps.runPowerShellJson(options))),
        spawnProcess: this.deps.spawnProcess,
        now: this.now,
        version: this.version,
        env: this.env,
        hostPid: this.processRef.pid,
        portProvider: this.deps.portProvider ?? (() => this.ctx?.get?.('webServer')?.port ?? null),
        frozenTimeoutMs: this.deps.frozenTimeoutMs ?? HANDOFF_FROZEN_TIMEOUT_MS,
      })
    if (this.disposed) return this
    this.resume =
      this.deps.resume ??
      new ResumeManager({
        ctx: this.ctx,
        env: this.env,
        now: this.now,
        enabled: this.resumeEnabled(),
        ledger: this.store?.resume ?? null,
        persist: async (ledger) => {
          await this.store?.writeResume(ledger)
        },
        controller: this.deps.sessionController,
        logMtime: this.deps.sessionLogMtime,
      })
    this.resume?.setEnabled(this.resumeEnabled())

    if (this.supported) {
      this.collector =
        this.deps.collector ??
        new CollectorSupervisor({
          scriptPath: join(resourcesDir, 'collector.ps1'),
          now: this.now,
          env: this.env,
          spawnProcess: this.deps.spawnProcess,
          onSample: (sample) => this.onSample(sample),
          onError: (error) => this.onCollectorError(error),
          onRecovered: (event) => this.notice('collector.recovered', { at: event.at }, 'info'),
          onStateChange: () => {},
        })
      this.collector.start()
    }

    this.tickTimer = (this.deps.setInterval ?? setInterval)(() => {
      this.tick().catch((error) => this.setError('tick', safeErrorMessage(error)))
    }, 1000)
    this.tickTimer.unref?.()
    this.runCapability('startup').catch((error) => this.setError('capability', safeErrorMessage(error)))
    this.showPreviousRestart()
    if (this.resumeEnabled()) this.startResumeScheduler()
    this.tick().catch(() => {})
    return this
  }

  showPreviousRestart() {
    const restart = this.store?.lastRestart
    if (restart === null || restart === undefined || typeof restart !== 'object') return
    const finishedAt = Number(restart.finishedAt)
    if (!Number.isFinite(finishedAt) || this.now() - finishedAt > 10 * 60 * 1000) return
    if (restart.status === 'succeeded') {
      this.notice(
        'restart.succeeded',
        {
          at: finishedAt,
          newPid: restart.newPid ?? null,
          pct: restart.memoryAfter?.pct ?? null,
        },
        'info',
      )
    } else if (restart.status === 'failed') {
      this.notice('restart.failed', { reason: restart.reason ?? 'unknown' }, 'error')
    }
  }

  scheduleProbes(at) {
    if (!this.supported || this.probesDisabled || this.disposed) return
    if (this.attributionRun === null && (this.attribution === null || at - this.attribution.at >= ATTRIBUTION_REFRESH_MS)) {
      this.refreshAttribution().catch((error) => this.setError('attribution', safeErrorMessage(error)))
    }
    const systemInterval = this.systemInfo?.ok === true ? SYSTEM_INFO_REFRESH_MS : 60000
    if (this.systemInfoRun === null && (this.systemInfo === null || at - this.systemInfo.at >= systemInterval)) {
      this.refreshSystemInfo().catch((error) => this.setError('system-info', safeErrorMessage(error)))
    }
    const crashInterval = this.crashHistory?.ok === true ? CRASH_HISTORY_REFRESH_MS : 60000
    if (this.crashHistoryRun === null && (this.crashHistory === null || at - this.crashHistory.at >= crashInterval)) {
      this.refreshCrashHistory().catch((error) => this.setError('crash-history', safeErrorMessage(error)))
    }
  }

  async refreshAttribution() {
    if (this.attributionRun !== null) return this.attributionRun
    const at = () => this.now()
    const probe = this.deps.attributionProbe
    this.attributionRun = (async () => {
      let result
      try {
        result = probe
          ? await probe({ hostPid: this.processRef.pid, mainPid: this.mainPid ?? 0, topN: ATTRIBUTION_TOP_N })
          : await sampleAttribution({
              scriptPath: join(resourcesDir, 'top.ps1'),
              hostPid: this.processRef.pid,
              mainPid: this.mainPid ?? 0,
              topN: ATTRIBUTION_TOP_N,
              env: this.env,
              spawnProcess: this.deps.spawnProcess,
              timeoutMs: this.deps.probeTimeoutMs,
              now: this.now,
            })
      } catch (error) {
        result = { ok: false, error: safeErrorMessage(error) }
      }
      if (this.disposed) return result
      this.attribution =
        result !== null && typeof result === 'object' && ('sharePct' in result || 'dshBytes' in result)
          ? result
          : normalizeAttribution(result, { at: at() })
      this.trackResidents(this.attribution)
      return this.attribution
    })().finally(() => {
      this.attributionRun = null
    })
    return this.attributionRun
  }

  async refreshSystemInfo() {
    if (this.systemInfoRun !== null) return this.systemInfoRun
    const now = this.now
    const probe = this.deps.systemProbe
    this.systemInfoRun = (async () => {
      let result
      try {
        result = probe
          ? await probe()
          : await sampleSystemInfo({
              scriptPath: join(resourcesDir, 'system-info.ps1'),
              env: this.env,
              spawnProcess: this.deps.spawnProcess,
              timeoutMs: this.deps.probeTimeoutMs,
              now,
            })
      } catch (error) {
        result = { ok: false, error: safeErrorMessage(error) }
      }
      if (this.disposed) return result
      this.systemInfo =
        result !== null && typeof result === 'object' && 'advice' in result ? result : normalizeSystemInfo(result, { at: now() })
      return this.systemInfo
    })().finally(() => {
      this.systemInfoRun = null
    })
    return this.systemInfoRun
  }

  async refreshCrashHistory() {
    if (this.crashHistoryRun !== null) return this.crashHistoryRun
    const now = this.now
    const probe = this.deps.crashProbe
    this.crashHistoryRun = (async () => {
      let result
      try {
        result = probe
          ? await probe({ days: CRASH_HISTORY_DAYS, limit: CRASH_HISTORY_LIMIT })
          : await sampleCrashHistory({
              scriptPath: join(resourcesDir, 'crash-history.ps1'),
              days: CRASH_HISTORY_DAYS,
              limit: CRASH_HISTORY_LIMIT,
              env: this.env,
              spawnProcess: this.deps.spawnProcess,
              timeoutMs: Math.max(this.deps.probeTimeoutMs ?? 0, 30000),
              now,
            })
      } catch (error) {
        result = { ok: false, error: safeErrorMessage(error) }
      }
      if (this.disposed) return result
      this.crashHistory =
        result !== null && typeof result === 'object' && 'crashCount' in result
          ? result
          : parseCrashHistory(result, { now: now(), days: CRASH_HISTORY_DAYS, limit: CRASH_HISTORY_LIMIT })
      return this.crashHistory
    })().finally(() => {
      this.crashHistoryRun = null
    })
    return this.crashHistoryRun
  }

  trackResidents(attribution) {
    const result = trackResidents({ tracked: this.residentTracked, attribution, thresholds: this.thresholds })
    this.residentTracked = result.tracked
    const at = Number(attribution?.at ?? this.now())
    for (const alert of result.alerts) {
      if (!shouldNotifyResident(this.residentCooldown, alert.pid, at, this.thresholds.residentNoticeMs)) continue
      this.residentCooldown[alert.pid] = at
      this.residentAlerts.push(alert)
      if (this.residentAlerts.length > 10) this.residentAlerts.splice(0, this.residentAlerts.length - 10)
      this.notice('attribution.resident-growing', {
        name: alert.name,
        pid: alert.pid,
        mb: Math.round(alert.bytes / (1024 * 1024)),
        deltaMb: Math.round(alert.growthBytes / (1024 * 1024)),
        spanMinutes: Math.max(1, Math.round(alert.spanMs / 60000)),
        ageMin: alert.ageMin ?? null,
        dsh: alert.dsh === true,
      }, 'warn')
      this.noteEvent('resident-growing', {
        detail: {
          pid: alert.pid,
          name: alert.name,
          exePath: alert.exePath,
          bytes: alert.bytes,
          growthBytes: alert.growthBytes,
          spanMs: alert.spanMs,
          dsh: alert.dsh,
        },
      }).catch(() => {})
    }
  }

  restartGate() {
    return evaluateRestartGate({
      attribution: this.attribution,
      gatePct: this.thresholds.restartGatePct,
      now: this.now(),
    })
  }

  startResumeScheduler() {
    if (this.resume === null || this.disposed) return
    this.stopResumeScheduler()
    this.resumeScanIndex = 0
    this.armResumeTimer(RESUME_SCAN_DELAYS_MS[0])
  }

  armResumeTimer(delayMs) {
    this.stopResumeScheduler()
    const timer = (this.deps.setTimeout ?? setTimeout)(() => {
      this.resumeTimer = null
      this.runResumeScan().catch((error) => this.setError('resume', safeErrorMessage(error)))
    }, Math.max(1000, delayMs))
    timer?.unref?.()
    this.resumeTimer = timer
  }

  stopResumeScheduler() {
    if (this.resumeTimer === null) return
    ;(this.deps.clearTimeout ?? clearTimeout)(this.resumeTimer)
    this.resumeTimer = null
  }

  async runResumeScan() {
    if (this.disposed || this.resume === null || !this.resumeEnabled()) return null
    const result = await this.resume.scanNow()
    if (this.disposed) return result
    if (result?.nextDueAt) {
      this.armResumeTimer(result.nextDueAt - this.now())
      return result
    }
    this.resumeScanIndex += 1
    if (this.resumeScanIndex < RESUME_SCAN_DELAYS_MS.length) {
      const next = RESUME_SCAN_DELAYS_MS[this.resumeScanIndex] - RESUME_SCAN_DELAYS_MS[this.resumeScanIndex - 1]
      this.armResumeTimer(next)
    }
    return result
  }

  historyItems(limit) {
    return this.store?.historyItems(limit) ?? []
  }

  async resumeNow() {
    if (this.disposed) return { ok: false, code: 'disposed', error: 'runtime is disposed' }
    if (!this.resumeEnabled()) return { ok: false, code: 'resume-disabled', error: 'crash resume is turned off' }
    if (this.resume === null) return { ok: false, code: 'resume-unavailable', error: 'the resume manager has not started' }
    const result = await this.resume.scanNow()
    return {
      ok: result.ok === true,
      code: result.code,
      error: result.error,
      at: result.at,
      resumed: result.resumed,
      candidates: result.candidates,
      deferred: result.deferred.length,
      actions: result.actions.slice(0, 10),
      skipped: result.skipped.slice(0, 10),
    }
  }

  capabilityHint(capability) {
    if (capability.ok) return null
    if (!this.supported) return 'capability.hint.platform'
    const reason = capability.reason ?? ''
    if (/not found/i.test(reason)) return 'capability.hint.powershell'
    if (/job/i.test(reason)) return 'capability.hint.job'
    return 'capability.hint.generic'
  }

  onSample(sample) {
    if (this.disposed) return
    const at = this.now()
    this.lastSample = sample
    this.lastSampleReceivedAt = at
    if (at - sample.ts > STALE_AFTER_MS) {
      const stale = this.machine.markUnavailable('stale-sample', at)
      if (stale !== null) this.onTransition(stale, sample)
      else this.syncAction()
      return
    }
    const transition = this.machine.feed(sample, at)
    if (transition !== null) this.onTransition(transition, sample)
    else this.syncAction()
    this.evaluate().catch((error) => this.setError('evaluate', safeErrorMessage(error)))
  }

  onTransition(transition) {
    const sample = this.lastSample
    if (transition.to !== 'critical' && this.pending !== null) {
      this.pending = null
      this.cancelRequested = false
      this.notice('action.canceled.recovered', { state: transition.to }, 'info')
    }
    if (transition.to === 'normal') {
      this.attemptedEpisodeId = null
      this.canceledEpisodeId = null
    }
    const severity = transition.to === 'critical' ? 'critical' : transition.to === 'warning' || transition.to === 'unknown' ? 'warn' : 'info'
    this.notice(`pressure.${transition.to}`, this.pressureParams(sample), severity)
    this.notePressureEvent(transition, sample)
    this.syncAction()
  }

  pressureParams(sample) {
    const pct = sample !== null ? (sample.commitUsed / sample.commitLimit) * 100 : null
    return {
      pct: pct === null ? null : Math.round(pct * 10) / 10,
      used: sample?.commitUsed ?? null,
      limit: sample?.commitLimit ?? null,
      available: sample === null ? null : sample.commitLimit - sample.commitUsed,
    }
  }

  notePressureEvent(transition, sample) {
    const event = {
      version: 1,
      kind: `pressure-${transition.to}`,
      at: transition.at,
      from: transition.from,
      to: transition.to,
      episodeId: transition.episodeId,
      pressure: this.machine.snapshot(transition.at),
      idle: this.lastActivity?.idle ?? null,
      action: this.action.state,
      restart: null,
      collectorError: this.collector?.state?.().lastError ?? null,
      cooldownUntil: this.cooldownUntil,
      capability: { ok: this.capability.ok, state: this.capability.state, reason: this.capability.reason },
      error: this.lastError?.message ?? null,
      sample: sample === null ? null : this.pressureParams(sample),
    }
    this.store?.recordEvent(event).catch((error) => this.setError('store', safeErrorMessage(error)))
  }

  onCollectorError(error) {
    this.setError('collector', `${error.kind}: ${error.message}`)
    if (error.kind === 'malformed') {
      this.noticeError('collector.malformed', { message: error.message })
    } else {
      this.noticeError('collector.failed', { message: error.message })
    }
    this.syncAction()
  }

  async tick() {
    if (this.disposed || !this.started || this.ticking) return
    this.ticking = true
    try {
      const at = this.now()
      if (this.cooldownUntil > 0 && this.cooldownUntil <= at) {
        this.cooldownUntil = 0
      }
      if (this.lastSample !== null && at - this.lastSample.ts > STALE_AFTER_MS) {
        const stale = this.machine.markUnavailable('stale-sample', at)
        if (stale !== null) this.onTransition(stale, this.lastSample)
      } else if (this.lastSample === null && this.machine.state === 'unknown' && this.machine.reason === 'no-data') {
        this.machine.reason = this.supported ? 'waiting-for-samples' : (this.platformReason ?? 'unsupported-platform')
      }
      if (at - this.lastRestartRefreshAt > 10000 && this.store !== null) {
        this.lastRestartRefreshAt = at
        this.store.refreshRestart().catch(() => {})
      }
      this.scheduleProbes(at)
      await this.evaluate()
    } finally {
      this.ticking = false
    }
  }

  async evaluate() {
    if (this.disposed) return
    const at = this.now()
    if (this.pending !== null) {
      await this.stepPending(at)
    } else if (this.shouldArm()) {
      this.arm()
    }
    this.syncAction()
  }

  shouldArm() {
    if (this.machine.state !== 'critical') return false
    if (!this.autoRestartEnabled()) return false
    if (!this.supported) return false
    if (!this.capability.ok) return false
    if (this.cooldownUntil > this.now()) return false
    const episodeId = this.machine.episodeId
    if (episodeId === null) return false
    if (this.attemptedEpisodeId === episodeId) return false
    if (this.canceledEpisodeId === episodeId) return false
    const gate = this.restartGate()
    if (!gate.allowed) {
      if (gate.code !== 'gate.disabled') {
        this.attemptedEpisodeId = episodeId
        this.noticeError('action.skipped.external', {
          code: gate.code,
          sharePct: gate.sharePct,
          gatePct: gate.gatePct,
        })
        this.setAction('observing', 'action.skipped.external', gate.code)
      }
      return false
    }
    return true
  }

  arm() {
    const episodeId = this.machine.episodeId
    this.pending = {
      episodeId,
      phase: 'waiting',
      idleStreak: 0,
      lastCheckAt: 0,
      graceUntil: 0,
      nextReminderAt: this.now() + WAITING_REMINDER_MS,
      createdAt: this.now(),
    }
    this.setAction('waiting', 'action.waiting')
    this.notice('action.waiting', {
      ...this.pressureParams(this.lastSample),
      reason: 'awaiting-idle-confirmation',
    }, 'warn')
  }

  async stepPending(at) {
    const pending = this.pending
    if (pending === null) return
    if (this.canceledEpisodeId === pending.episodeId) {
      this.pending = null
      return
    }
    if (!this.autoRestartEnabled()) {
      this.pending = null
      this.notice('action.canceled.disabled', {}, 'info')
      return
    }
    if (!this.supported || !this.capability.ok) {
      this.pending = null
      this.notice('action.canceled.capability', { reason: this.capability.reason ?? this.platformReason }, 'error')
      return
    }
    if (this.cooldownUntil > at) {
      this.pending = null
      this.setAction('cooldown', 'action.cooldown')
      return
    }
    if (this.machine.state !== 'critical') {
      this.pending = null
      return
    }
    if (this.lastSample === null || at - this.lastSample.ts > STALE_AFTER_MS) {
      this.pending = null
      return
    }
    if (at >= pending.nextReminderAt) {
      pending.nextReminderAt = at + WAITING_REMINDER_MS
      this.notice('action.waitingReminder', {
        reason: this.lastActivity?.reason ?? 'unconfirmed',
        idle: this.lastActivity?.idle ?? null,
      }, 'warn')
    }
    const interval = pending.phase === 'confirming' ? 500 : 1000
    if (at - pending.lastCheckAt < interval) return
    pending.lastCheckAt = at
    const result = await this.checkActivity()
    const current = this.pending
    if (current === null || current !== pending) return
    this.lastActivity = result
    if (!result.idle) {
      current.idleStreak = 0
      if (current.phase === 'confirming') {
        current.phase = 'waiting'
        current.graceUntil = 0
        this.setAction('waiting', 'action.waiting')
        this.notice('action.confirmationCanceled', { reason: result.reason }, 'warn')
      } else {
        this.setAction('waiting', 'action.waiting')
      }
      return
    }
    current.idleStreak += 1
    if (current.phase === 'waiting') {
      if (current.idleStreak >= IDLE_CONFIRM_CHECKS) {
        current.phase = 'confirming'
        current.graceUntil = this.now() + IDLE_GRACE_MS
        this.setAction('confirming', 'action.confirming')
        this.notice('action.confirming', {}, 'info')
      }
      return
    }
    if (current.phase === 'confirming' && this.now() >= current.graceUntil) {
      await this.performHandoff(pending)
    }
  }

  async checkActivity() {
    const check = this.deps.activity ?? ((ctx) => inspectActivity(ctx, { now: this.now }))
    try {
      return await check(this.ctx)
    } catch (error) {
      return { idle: false, reason: `activity-error: ${safeErrorMessage(error)}`, checkedAt: this.now() }
    }
  }

  handoffPreconditions() {
    const at = this.now()
    if (this.machine.state !== 'critical') return { ok: false, reason: `pressure is ${this.machine.state}` }
    if (this.lastSample === null || at - this.lastSample.ts > STALE_AFTER_MS) {
      return { ok: false, reason: 'pressure sample is stale' }
    }
    if (!this.autoRestartEnabled()) return { ok: false, reason: 'auto restart is disabled' }
    if (this.cooldownUntil > at) return { ok: false, reason: 'cooldown is active' }
    if (!this.supported) return { ok: false, reason: this.platformReason ?? 'unsupported platform' }
    if (!this.capability.ok) return { ok: false, reason: this.capability.reason ?? 'helper capability check has not passed' }
    if (this.machine.episodeId !== null && this.canceledEpisodeId === this.machine.episodeId) {
      return { ok: false, reason: 'canceled by the user' }
    }
    const gate = this.restartGate()
    if (!gate.allowed && gate.code !== 'gate.disabled') {
      return { ok: false, reason: `restart gate blocked: ${gate.code}` }
    }
    return { ok: true }
  }

  async performHandoff(pendingToken) {
    const episodeId = this.machine.episodeId
    this.setAction('handoff', 'action.handoff')
    this.notice('restart.attempt', this.pressureParams(this.lastSample), 'critical')
    await this.noteEvent('restart-attempt', {
      restart: { attempted: true, ok: null, phase: 'preparing' },
      idle: this.lastActivity?.idle ?? null,
    })
    this.handoffActive = true
    let failureReason = null
    try {
      const prepared = await this.handoff.prepare({
        trigger: {
          episodeId,
          pressure: this.machine.snapshot(this.now()),
          idle: this.lastActivity?.idle ?? null,
        },
      })
      if (prepared.ok !== true) {
        failureReason = prepared.reason ?? 'handoff preparation failed'
        await this.failHandoff(failureReason, episodeId)
        return
      }
      const verified = await this.handoff.waitForVerified()
      if (this.cancelRequested) {
        await this.handoff.abort('user canceled')
        this.cancelRequested = false
        this.pending = null
        this.setAction('observing', 'action.canceled.user')
        return
      }
      if (this.pending === null || this.pending !== pendingToken || this.machine.episodeId !== episodeId) {
        await this.handoff.abort('handoff was superseded')
        return
      }
      if (verified.status !== 'verified') {
        failureReason = verified.value?.reason ?? verified.error ?? 'the helper did not verify the target'
        await this.handoff.abort(failureReason)
        await this.failHandoff(failureReason, episodeId)
        return
      }
      const fresh = await this.checkActivity()
      this.lastActivity = fresh
      if (!fresh.idle) {
        await this.handoff.abort('activity started before handoff')
        this.pending.phase = 'waiting'
        this.pending.idleStreak = 0
        this.pending.graceUntil = 0
        this.setAction('waiting', 'action.waiting')
        this.notice('action.confirmationCanceled', { reason: fresh.reason }, 'warn')
        return
      }
      if (this.cancelRequested || this.pending === null || this.pending !== pendingToken) {
        await this.handoff.abort('canceled before handoff')
        this.cancelRequested = false
        return
      }
      const preconditions = this.handoffPreconditions()
      if (!preconditions.ok) {
        await this.handoff.abort(preconditions.reason)
        this.pending = null
        this.setAction(this.cooldownUntil > this.now() ? 'cooldown' : 'observing', null, preconditions.reason)
        this.notice('action.canceled.recovered', { state: this.machine.state, reason: preconditions.reason }, 'info')
        return
      }

      const until = this.now() + this.thresholds.cooldownMs
      await this.store.setCooldown({ until, at: this.now(), episodeId })
      this.cooldownUntil = until
      this.attemptedEpisodeId = episodeId
      this.pending = null
      await this.handoff.writeGo()
      const frozen = await this.handoff.waitForFrozen()
      if (frozen.status !== 'frozen') {
        failureReason = frozen.value?.reason ?? frozen.error ?? 'the helper did not freeze the Electron main process'
        await this.handoff.abort(failureReason)
        await this.failHandoff(failureReason, episodeId, { cooldownAlreadySet: true })
        return
      }
      this.handoffStarted = true
      this.setAction('handoff', 'action.handoff')
      this.notice('restart.handoff', this.pressureParams(this.lastSample), 'critical')
      await this.noteEvent('restart-handoff', {
        restart: { attempted: true, ok: null, phase: 'handoff', cooldownUntil: this.cooldownUntil },
      })
      this.scheduleDisconnect()
    } catch (error) {
      failureReason = safeErrorMessage(error)
      await this.handoff.abort(failureReason).catch(() => {})
      await this.failHandoff(failureReason, episodeId)
    } finally {
      this.handoffActive = false
    }
  }

  scheduleDisconnect() {
    if (this.disconnectScheduled) return
    this.disconnectScheduled = true
    this.connectTimer = (this.deps.setTimeout ?? setTimeout)(() => {
      try {
        if (this.processRef.connected !== false && typeof this.processRef.disconnect === 'function') {
          this.processRef.disconnect()
        }
      } catch (error) {
        this.setError('disconnect', safeErrorMessage(error))
      }
    }, 150)
    this.connectTimer.unref?.()
  }

  async failHandoff(reason, episodeId, { cooldownAlreadySet = false } = {}) {
    await this.handoff.abort(reason).catch(() => {})
    if (!cooldownAlreadySet && this.cooldownUntil <= this.now()) {
      const until = this.now() + this.thresholds.cooldownMs
      this.cooldownUntil = until
      await this.store.setCooldown({ until, at: this.now(), episodeId }).catch((error) => {
        this.setError('store', safeErrorMessage(error))
      })
    }
    if (episodeId !== null) this.attemptedEpisodeId = episodeId
    this.pending = null
    this.setError('handoff', reason)
    this.notice('restart.failed', { reason }, 'error')
    await this.noteEvent('restart-failed', {
      restart: { attempted: true, ok: false, reason, cooldownUntil: this.cooldownUntil },
    })
    this.setAction(this.cooldownUntil > this.now() ? 'cooldown' : 'observing', null, reason)
  }

  async noteEvent(kind, extra = {}) {
    const event = {
      version: 1,
      kind,
      at: this.now(),
      pressure: this.machine.snapshot(this.now()),
      idle: extra.idle ?? this.lastActivity?.idle ?? null,
      action: this.action.state,
      restart: extra.restart ?? null,
      detail: extra.detail ?? null,
      collectorError: this.collector?.state?.().lastError ?? null,
      cooldownUntil: this.cooldownUntil,
      capability: { ok: this.capability.ok, state: this.capability.state, reason: this.capability.reason },
      error: this.lastError?.message ?? null,
    }
    this.store?.recordEvent(event).catch((error) => this.setError('store', safeErrorMessage(error)))
    return event
  }

  syncAction() {
    if (this.pending !== null) {
      if (this.action.state !== 'waiting' && this.action.state !== 'confirming' && this.action.state !== 'handoff') {
        this.setAction(this.pending.phase === 'confirming' ? 'confirming' : 'waiting')
      }
      return
    }
    if (this.handoffStarted) {
      this.setAction('handoff', 'action.handoff')
      return
    }
    if (this.cooldownUntil > this.now() && (this.machine.state === 'critical' || this.machine.state === 'warning')) {
      this.setAction('cooldown', 'action.cooldown')
      return
    }
    this.setAction('observing', 'action.observing')
  }

  runCapability(reason = 'manual') {
    if (this.capabilityRun !== null) return this.capabilityRun
    const previous = this.capability
    this.capability = { state: 'checking', ok: false, reason: previous.reason ?? null, checkedAt: previous.checkedAt ?? null }
    const check = this.deps.capabilityCheck ?? ((options) => this.handoff.checkCapability(options))
    this.capabilityRun = (async () => {
      let result
      try {
        result = await check({ timeoutMs: 15000 })
      } catch (error) {
        result = { ok: false, reason: safeErrorMessage(error), checkedAt: this.now() }
      }
      if (this.disposed) return result
      this.capability = {
        state: result.ok === true ? 'ok' : 'unavailable',
        ok: result.ok === true,
        reason: result.ok === true ? null : (result.reason ?? 'capability check failed'),
        checkedAt: result.checkedAt ?? this.now(),
        helperPid: result.helperPid ?? null,
        mainPid: result.mainPid ?? null,
        inJob: result.inJob === true,
        reasonCode: reason,
      }
      this.capability.hint = this.capabilityHint(this.capability)
      if (this.capability.ok && Number.isFinite(result.mainPid)) this.mainPid = result.mainPid
      this.store?.writeCapability(this.capability).catch(() => {})
      if (this.capability.ok) {
        if (previous.state === 'unavailable') this.notice('capability.available', {}, 'info')
      } else {
        if (previous.state !== 'unavailable') this.notice('capability.unavailable', { reason: this.capability.reason }, 'error')
        this.setError('capability', this.capability.reason)
      }
      if (this.capability.ok && this.autoRestartEnabled()) {
        this.tick().catch(() => {})
      }
      return result
    })().finally(() => {
      this.capabilityRun = null
    })
    return this.capabilityRun
  }

  onConfigUpdate(paths) {
    if (this.disposed) return
    const changed = Array.isArray(paths) ? paths : []
    const touches = (key) =>
      changed.some((path) => (Array.isArray(path) ? path.includes(key) : path === key || (typeof path === 'string' && path.includes(key))))
    const thresholdChanged = [
      'warningPct',
      'criticalPct',
      'criticalAvailMb',
      'confirmSamples',
      'cooldownMinutes',
      'restartGatePct',
      'residentGrowMb',
    ].some(touches)
    if (thresholdChanged) {
      const next = resolveThresholds(this.rawConfig)
      this.thresholds = next
      this.machine.setThresholds(next)
      this.notice('settings.thresholds', { ...next }, 'info')
      this.tick().catch(() => {})
    }
    if (touches('resumeAfterCrash')) {
      const resumeEnabled = this.resumeEnabled()
      this.resume?.setEnabled(resumeEnabled)
      if (resumeEnabled) this.startResumeScheduler()
      else this.stopResumeScheduler()
      this.notice('settings.resume', { enabled: resumeEnabled }, 'info')
    }
    if (!touches('autoRestart')) {
      this.syncAction()
      return
    }
    const enabled = this.autoRestartEnabled()
    if (!enabled) {
      const hadPending = this.pending !== null
      this.pending = null
      if (this.handoffActive && !this.handoffStarted) this.cancelRequested = true
      if (hadPending) this.notice('action.canceled.disabled', {}, 'info')
      this.notice('settings.autoRestart', { enabled: false }, 'info')
    } else {
      this.notice('settings.autoRestart', { enabled: true }, 'info')
      if (!this.capability.ok) this.runCapability('enabled').catch(() => {})
      this.tick().catch(() => {})
    }
    this.syncAction()
  }

  async cancel() {
    if (this.disposed) return { ok: false, code: 'disposed', error: 'runtime is disposed' }
    if (this.handoffStarted) {
      return { ok: false, code: 'handoff-in-progress', error: 'the restart handoff has already started' }
    }
    if (this.pending === null) {
      return { ok: true, canceled: false }
    }
    this.canceledEpisodeId = this.pending.episodeId
    this.pending = null
    this.cancelRequested = this.handoffActive
    if (this.handoffActive && typeof this.handoff?.abort === 'function') {
      await this.handoff.abort('canceled by the user').catch(() => {})
    }
    this.notice('action.canceled.user', {}, 'info')
    this.syncAction()
    return { ok: true, canceled: true }
  }

  status() {
    const at = this.now()
    const pressure = this.machine.snapshot(at)
    const collectorState = this.collector?.state?.() ?? {
      running: false,
      pid: null,
      restarts: 0,
      lastSampleAt: null,
      lastError: null,
      lastExit: null,
    }
    const stale =
      this.lastSample === null || !Number.isFinite(this.lastSample.ts) || at - this.lastSample.ts > STALE_AFTER_MS
    const elapsed = collectorState.lastSampleAt === null ? null : Math.max(0, at - collectorState.lastSampleAt)
    return {
      ok: true,
      sessionId: this.sessionId,
      plugin: {
        name: 'dsh-memory-watchdog',
        version: this.version,
        startedAt: this.startedAt,
        hostPid: this.processRef.pid,
        hostRss: this.processRef.memoryUsage?.().rss ?? null,
      },
      platform: {
        supported: this.supported,
        platform: this.platform,
        arch: this.arch,
        reason: this.platformReason,
      },
      autoRestart: {
        enabled: this.autoRestartEnabled(),
        capability: { ...this.capability },
      },
      config: configSnapshot(this.rawConfig, this.thresholds),
      gate: this.restartGate(),
      attribution:
        this.attribution === null
          ? { ok: false, at: null, error: 'not-sampled-yet', sharePct: null, dshBytes: null, top: [] }
          : {
              ok: this.attribution.ok,
              at: this.attribution.at,
              sampledAt: this.attribution.sampledAt ?? null,
              ageMs: this.attribution.at === null ? null : Math.max(0, at - this.attribution.at),
              error: this.attribution.error ?? null,
              systemCommitUsed: this.attribution.systemCommitUsed,
              dshBytes: this.attribution.dshBytes,
              dshCount: this.attribution.dshCount,
              sharePct: this.attribution.sharePct,
              top: this.attribution.top,
            },
      system:
        this.systemInfo === null
          ? { ok: false, error: 'not-sampled-yet', pagefiles: [], advice: [] }
          : { ...this.systemInfo },
      crashes:
        this.crashHistory === null
          ? { ok: false, error: 'not-sampled-yet', items: [] }
          : {
              ok: this.crashHistory.ok,
              at: this.crashHistory.at,
              error: this.crashHistory.error ?? null,
              days: this.crashHistory.days,
              logDir: this.crashHistory.logDir ?? null,
              crashCount: this.crashHistory.crashCount ?? 0,
              eventCount: this.crashHistory.eventCount ?? 0,
              items: (this.crashHistory.items ?? []).slice(0, HISTORY_STATUS_ITEMS),
            },
      history: this.store?.historyItems(HISTORY_STATUS_ITEMS) ?? [],
      residents: {
        tracked: Object.keys(this.residentTracked).length,
        growMb: this.thresholds.residentGrowMb,
        windowMs: this.thresholds.residentWindowMs,
        alerts: this.residentAlerts.slice(-5).map((alert) => ({
          pid: alert.pid,
          name: alert.name,
          dsh: alert.dsh,
          bytes: alert.bytes,
          growthBytes: alert.growthBytes,
          spanMs: alert.spanMs,
          ageMin: alert.ageMin,
          exePath: alert.exePath,
          at: alert.at,
        })),
      },
      resume: this.resume?.state() ?? { enabled: false, scanning: false, lastScanAt: null, lastScan: null, ledger: [] },
      pressure: {
        ...pressure,
        stale,
        state: this.machine.state,
        sampleAgeMs: pressure.sampleAgeMs,
      },
      action: {
        state: this.action.state,
        since: this.action.since,
        code: this.action.code,
        detail: this.action.detail,
        cancelable: this.pending !== null && !this.handoffStarted,
        pendingSince: this.pending?.createdAt ?? null,
        idleChecks: this.pending?.idleStreak ?? 0,
        graceUntil: this.pending?.graceUntil || null,
        phase: this.pending?.phase ?? null,
      },
      cooldown: {
        active: this.cooldownUntil > at,
        until: this.cooldownUntil > 0 ? this.cooldownUntil : null,
        remainingMs: Math.max(0, this.cooldownUntil - at),
        lastAttemptAt: this.store?.state?.lastAttemptAt ?? null,
      },
      episode: {
        id: this.machine.episodeId,
        attempted: this.machine.episodeId !== null && this.attemptedEpisodeId === this.machine.episodeId,
        canceled: this.machine.episodeId !== null && this.canceledEpisodeId === this.machine.episodeId,
      },
      activity: this.lastActivity
        ? { ...this.lastActivity }
        : { idle: null, reason: 'not-checked', checkedAt: null },
      collector: {
        ...collectorState,
        stale,
        sampleAgeMs: elapsed,
      },
      lastError: this.lastError,
      lastEvent: this.store?.lastEvent ?? null,
      lastRestart: this.store?.lastRestart ?? null,
      notices: this.notices.slice(-20),
      nextCheckInMs: this.pending !== null ? Math.max(0, 1000 - (at - this.pending.lastCheckAt)) : null,
      handoff: { started: this.handoffStarted, active: this.handoffActive },
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopResumeScheduler()
    if (this.tickTimer !== null) {
      (this.deps.clearInterval ?? clearInterval)(this.tickTimer)
      this.tickTimer = null
    }
    if (this.connectTimer !== null) {
      (this.deps.clearTimeout ?? clearTimeout)(this.connectTimer)
      this.connectTimer = null
    }
    if (this.handoffActive && !this.handoffStarted && typeof this.handoff?.abort === 'function') {
      await this.handoff.abort('plugin disposed').catch(() => {})
    }
    if (this.collector !== null) {
      await this.collector.stop().catch(() => {})
    }
    await this.store?.flush().catch(() => {})
  }
}
