import {
  ATTRIBUTION_MIN_TRACK_BYTES,
  CONFIRM_SAMPLES,
  COOLDOWN_MS,
  CRITICAL_ABS_PCT,
  CRITICAL_AVAIL_BYTES,
  CRITICAL_PCT,
  RESTART_GATE_MIN_SHARE_PCT,
  RESIDENT_GROW_MB,
  RESIDENT_NOTICE_MS,
  RESIDENT_WINDOW_MS,
  WARNING_AVAIL_BYTES,
  WARNING_PCT,
} from './constants.js'
import { unwrapVolatile } from './config.js'

export const THRESHOLD_LIMITS = {
  warningPct: { min: 50, max: 95, default: WARNING_PCT, step: 1 },
  criticalPct: { min: 55, max: 99, default: CRITICAL_PCT, step: 1 },
  criticalAvailMb: { min: 256, max: 32768, default: Math.round(CRITICAL_AVAIL_BYTES / (1024 * 1024)), step: 256 },
  confirmSamples: { min: 1, max: 10, default: CONFIRM_SAMPLES, step: 1 },
  cooldownMinutes: { min: 5, max: 1440, default: Math.round(COOLDOWN_MS / 60000), step: 5 },
  restartGatePct: { min: 0, max: 100, default: RESTART_GATE_MIN_SHARE_PCT, step: 5 },
  residentGrowMb: { min: 128, max: 8192, default: RESIDENT_GROW_MB, step: 128 },
}

function clampNumber(value, { min, max, default: fallback }) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function resolveThresholds(rawConfig = {}) {
  const warningPct = Math.round(clampNumber(unwrapVolatile(rawConfig?.warningPct), THRESHOLD_LIMITS.warningPct))
  let criticalPct = Math.round(clampNumber(unwrapVolatile(rawConfig?.criticalPct), THRESHOLD_LIMITS.criticalPct))
  if (criticalPct <= warningPct) criticalPct = Math.min(THRESHOLD_LIMITS.criticalPct.max, warningPct + 1)
  const criticalAvailMb = Math.round(clampNumber(unwrapVolatile(rawConfig?.criticalAvailMb), THRESHOLD_LIMITS.criticalAvailMb))
  const confirmSamples = Math.round(clampNumber(unwrapVolatile(rawConfig?.confirmSamples), THRESHOLD_LIMITS.confirmSamples))
  const cooldownMinutes = Math.round(clampNumber(unwrapVolatile(rawConfig?.cooldownMinutes), THRESHOLD_LIMITS.cooldownMinutes))
  const restartGatePct = Math.round(clampNumber(unwrapVolatile(rawConfig?.restartGatePct), THRESHOLD_LIMITS.restartGatePct))
  const residentGrowMb = Math.round(clampNumber(unwrapVolatile(rawConfig?.residentGrowMb), THRESHOLD_LIMITS.residentGrowMb))
  return {
    warningPct,
    criticalPct,
    criticalAbsPct: Math.max(CRITICAL_ABS_PCT, criticalPct),
    criticalAvailBytes: criticalAvailMb * 1024 * 1024,
    warningAvailBytes: WARNING_AVAIL_BYTES,
    criticalExitPct: Math.max(0, criticalPct - 5),
    normalPct: Math.max(0, warningPct - 5),
    confirmSamples,
    cooldownMs: cooldownMinutes * 60000,
    cooldownMinutes,
    restartGatePct,
    criticalAvailMb,
    residentGrowMb,
    residentGrowBytes: residentGrowMb * 1024 * 1024,
    residentMinBytes: ATTRIBUTION_MIN_TRACK_BYTES,
    residentWindowMs: RESIDENT_WINDOW_MS,
    residentNoticeMs: RESIDENT_NOTICE_MS,
  }
}

export const DEFAULT_THRESHOLDS = resolveThresholds({})
