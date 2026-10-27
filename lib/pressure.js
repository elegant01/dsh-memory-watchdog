import { DEFAULT_THRESHOLDS } from './thresholds.js'

export function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isValidSample(sample) {
  if (sample === null || typeof sample !== 'object') return false
  if (!isFiniteNonNegative(sample.commitUsed)) return false
  if (!isFiniteNonNegative(sample.commitLimit) || sample.commitLimit <= 0) return false
  if (sample.commitUsed > sample.commitLimit) return false
  if (!isFiniteNonNegative(sample.physicalTotal)) return false
  if (!isFiniteNonNegative(sample.physicalAvailable)) return false
  if (sample.physicalAvailable > sample.physicalTotal && sample.physicalTotal > 0) return false
  return true
}

export function classifySample(sample, thresholds = DEFAULT_THRESHOLDS) {
  if (!isValidSample(sample)) return null
  const pct = (sample.commitUsed / sample.commitLimit) * 100
  const available = sample.commitLimit - sample.commitUsed
  const critical =
    (pct >= thresholds.criticalPct && available <= thresholds.criticalAvailBytes) || pct >= thresholds.criticalAbsPct
  const warning = pct >= thresholds.warningPct || available <= thresholds.warningAvailBytes
  const calm = !warning && pct < thresholds.normalPct
  const belowCriticalExit = pct < thresholds.criticalExitPct
  return { pct, available, critical, warning, calm, belowCriticalExit }
}

function candidateFor(state, c) {
  switch (state) {
    case 'normal':
      return c.warning ? 'warning' : null
    case 'warning':
      if (c.critical) return 'critical'
      if (c.calm) return 'normal'
      return null
    case 'critical':
      return c.belowCriticalExit ? 'warning' : null
    case 'unknown':
      if (c.critical) return 'critical'
      if (c.warning) return 'warning'
      return c.calm ? 'normal' : null
    default:
      return null
  }
}

export class PressureMachine {
  constructor({ now = Date.now, thresholds = DEFAULT_THRESHOLDS } = {}) {
    this.now = now
    this.thresholds = thresholds
    this.state = 'unknown'
    this.since = now()
    this.reason = 'no-data'
    this.streak = 0
    this.candidate = null
    this.lastSample = null
    this.lastTransition = null
    this.episodeId = null
    this.episodeSerial = 0
  }

  feed(sample, now = this.now()) {
    if (!isValidSample(sample)) {
      return this.markUnavailable('invalid-sample', now)
    }
    const c = classifySample(sample, this.thresholds)
    const previous = this.state
    this.lastSample = sample
    this.reason = null
    const candidate = candidateFor(previous, c)
    if (candidate === null) {
      this.streak = 0
      this.candidate = null
      return null
    }
    if (this.candidate === candidate) this.streak += 1
    else {
      this.candidate = candidate
      this.streak = 1
    }
    if (this.streak < this.thresholds.confirmSamples) return null
    this.streak = 0
    this.candidate = null
    return this.transition(previous, candidate, now, 'samples')
  }

  markUnavailable(reason, now = this.now()) {
    this.reason = reason
    this.streak = 0
    this.candidate = null
    if (this.state === 'unknown') return null
    return this.transition(this.state, 'unknown', now, reason)
  }

  transition(from, to, at, reason) {
    const previousEpisode = this.episodeId
    this.state = to
    this.since = at
    if (to === 'critical') {
      this.episodeSerial += 1
      this.episodeId = `${at}-${this.episodeSerial}`
    } else if (to === 'normal') {
      this.episodeId = null
    }
    const event = { from, to, at, reason, episodeId: this.episodeId, previousEpisode }
    this.lastTransition = event
    return event
  }

  setThresholds(thresholds) {
    if (thresholds === null || typeof thresholds !== 'object') return
    this.thresholds = thresholds
    this.streak = 0
    this.candidate = null
  }

  snapshot(now = this.now()) {
    const sample = this.lastSample
    const c = sample === null ? null : classifySample(sample, this.thresholds)
    const age = sample === null ? null : Math.max(0, now - sample.ts)
    return {
      state: this.state,
      since: this.since,
      reason: this.reason,
      episodeId: this.episodeId,
      streak: this.streak,
      candidate: this.candidate,
      sampleAt: sample?.ts ?? null,
      sampleAgeMs: age,
      commitUsed: sample?.commitUsed ?? null,
      commitLimit: sample?.commitLimit ?? null,
      availableCommit: c?.available ?? null,
      pct: c?.pct ?? null,
      physicalTotal: sample?.physicalTotal ?? null,
      physicalAvailable: sample?.physicalAvailable ?? null,
    }
  }
}
