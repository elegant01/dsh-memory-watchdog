import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS, resolveThresholds, THRESHOLD_LIMITS } from '../lib/thresholds.js'
import { PressureMachine } from '../lib/pressure.js'
import { CONFIRM_SAMPLES, COOLDOWN_MS, CRITICAL_PCT, WARNING_PCT } from '../lib/constants.js'
import { makeClock, sample, GIB } from './helpers.js'

test('default thresholds match the documented constants', () => {
  assert.equal(DEFAULT_THRESHOLDS.warningPct, WARNING_PCT)
  assert.equal(DEFAULT_THRESHOLDS.criticalPct, CRITICAL_PCT)
  assert.equal(DEFAULT_THRESHOLDS.confirmSamples, CONFIRM_SAMPLES)
  assert.equal(DEFAULT_THRESHOLDS.cooldownMs, COOLDOWN_MS)
  assert.equal(DEFAULT_THRESHOLDS.criticalAvailMb, 2048)
  assert.equal(DEFAULT_THRESHOLDS.criticalExitPct, CRITICAL_PCT - 5)
  assert.equal(DEFAULT_THRESHOLDS.normalPct, WARNING_PCT - 5)
})

test('configured values are clamped into the supported range', () => {
  const result = resolveThresholds({
    warningPct: 10,
    criticalPct: 500,
    criticalAvailMb: 1,
    confirmSamples: 0,
    cooldownMinutes: 99999,
    restartGatePct: -5,
  })
  assert.equal(result.warningPct, THRESHOLD_LIMITS.warningPct.min)
  assert.equal(result.criticalPct, THRESHOLD_LIMITS.criticalPct.max)
  assert.equal(result.criticalAvailMb, THRESHOLD_LIMITS.criticalAvailMb.min)
  assert.equal(result.confirmSamples, THRESHOLD_LIMITS.confirmSamples.min)
  assert.equal(result.cooldownMinutes, THRESHOLD_LIMITS.cooldownMinutes.max)
  assert.equal(result.restartGatePct, 0)
  assert.ok(result.criticalPct > result.warningPct)
})

test('critical always stays above warning even when configured lower', () => {
  const result = resolveThresholds({ warningPct: 90, criticalPct: 60 })
  assert.equal(result.warningPct, 90)
  assert.equal(result.criticalPct, 91)
  assert.ok(result.criticalExitPct < result.criticalPct)
  assert.ok(result.normalPct < result.warningPct)
})

test('volatile config wrappers are unwrapped and junk falls back to defaults', () => {
  const wrapped = (value) => ({ get: () => value })
  const result = resolveThresholds({ warningPct: wrapped(70), confirmSamples: 'nope', cooldownMinutes: null })
  assert.equal(result.warningPct, 70)
  assert.equal(result.confirmSamples, CONFIRM_SAMPLES)
  assert.equal(result.cooldownMinutes, DEFAULT_THRESHOLDS.cooldownMinutes)
})

test('the pressure machine honours custom percentages and confirmation counts', () => {
  const clock = makeClock()
  const thresholds = resolveThresholds({ warningPct: 60, criticalPct: 70, confirmSamples: 1, normalPct: 40 })
  const machine = new PressureMachine({ now: () => clock.now, thresholds })
  clock.advance(5000)
  const calm = machine.feed(sample(40, clock.now), clock.now)
  assert.equal(calm.to, 'normal')
  clock.advance(5000)
  const first = machine.feed(sample(65, clock.now), clock.now)
  assert.equal(first.to, 'warning')
  clock.advance(5000)
  const second = machine.feed(sample(75, clock.now, { limit: 8 * GIB }), clock.now)
  assert.equal(second.to, 'critical')
  clock.advance(5000)
  const third = machine.feed(sample(50, clock.now), clock.now)
  assert.equal(third.to, 'warning')
})

test('setThresholds applies live changes and resets a partial streak', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  for (const value of [70, 70, 70]) {
    clock.advance(5000)
    machine.feed(sample(value, clock.now), clock.now)
  }
  clock.advance(5000)
  machine.feed(sample(82, clock.now), clock.now)
  assert.equal(machine.streak, 1)
  machine.setThresholds(resolveThresholds({ warningPct: 60, confirmSamples: 1 }))
  assert.equal(machine.streak, 0)
  clock.advance(5000)
  const transition = machine.feed(sample(65, clock.now), clock.now)
  assert.equal(transition.to, 'warning')
})
