import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySample, isValidSample, PressureMachine } from '../lib/pressure.js'
import { CONFIRM_SAMPLES, GIB } from '../lib/constants.js'
import { DEFAULT_LIMIT, makeClock, sample } from './helpers.js'

function feedMany(machine, values, clock, options) {
  const transitions = []
  for (let index = 0; index < values.length; index += 1) {
    clock.advance(5000)
    const result = machine.feed(sample(values[index], clock.now, options), clock.now)
    if (result !== null) transitions.push(result)
  }
  return transitions
}

function toNormal(machine, clock) {
  return feedMany(machine, [70, 70, 70], clock)
}

function toWarning(machine, clock) {
  toNormal(machine, clock)
  return feedMany(machine, [82, 82, 82], clock)
}

function toCritical(machine, clock) {
  toWarning(machine, clock)
  return feedMany(machine, [96, 96, 96], clock)
}

test('sample validation rejects impossible commit data', () => {
  assert.equal(isValidSample(null), false)
  assert.equal(isValidSample(sample(50, 1)), true)
  assert.equal(isValidSample({ ...sample(50, 1), commitLimit: 0 }), false)
  assert.equal(isValidSample({ ...sample(50, 1), commitUsed: DEFAULT_LIMIT + 1 }), false)
  assert.equal(isValidSample({ ...sample(50, 1), physicalAvailable: 65 * GIB, physicalTotal: 64 * GIB }), false)
  assert.equal(isValidSample({ ...sample(50, 1), commitUsed: Number.NaN }), false)
})

test('classification uses percentage plus absolute commit margin', () => {
  const limit = 100 * GIB
  const at79 = classifySample(sample(79.9, 1, { limit }))
  assert.equal(at79.warning, false)
  assert.equal(at79.calm, false)

  const at80 = classifySample(sample(80, 1, { limit }))
  assert.equal(at80.warning, true)
  assert.equal(at80.critical, false)

  const lowAvailable = classifySample(sample(70, 1, { limit: 100 * GIB }))
  assert.equal(lowAvailable.warning, false)

  const absoluteMargin = classifySample({
    ts: 1,
    commitUsed: 30 * GIB,
    commitLimit: 100 * GIB,
    physicalTotal: 64 * GIB,
    physicalAvailable: 32 * GIB,
  })
  assert.equal(absoluteMargin.warning, false)
})

test('warning also fires on the absolute available-commit margin', () => {
  const limit = 21 * GIB
  const result = classifySample(sample(72, 1, { limit }))
  assert.equal(result.available, 21 * GIB - Math.round((21 * GIB * 72) / 100))
  assert.ok(result.available <= 6 * GIB)
  assert.equal(result.warning, true)
})

test('critical requires 90% AND <=2GiB available, or 95% alone', () => {
  const twenty = classifySample(sample(90, 1, { limit: 20 * GIB }))
  assert.equal(twenty.critical, true)

  const hundred = classifySample(sample(90, 1, { limit: 100 * GIB }))
  assert.equal(hundred.critical, false)
  assert.equal(hundred.warning, true)

  const absolute = classifySample(sample(95, 1, { limit: 100 * GIB }))
  assert.equal(absolute.critical, true)
  assert.ok(absolute.available > 2 * GIB)
})

test('three consecutive samples are required for every transition', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toNormal(machine, clock)
  const transitions = feedMany(machine, [82, 82, 82], clock)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].from, 'normal')
  assert.equal(transitions[0].to, 'warning')
  assert.equal(machine.streak, 0)
})

test('two matching samples change nothing and a stray sample resets the streak', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toNormal(machine, clock)
  assert.equal(feedMany(machine, [82, 82], clock).length, 0)
  assert.equal(machine.state, 'normal')
  assert.equal(machine.streak, 2)
  clock.advance(5000)
  machine.feed(sample(60, clock.now), clock.now)
  assert.equal(machine.candidate, null)
  assert.equal(machine.streak, 0)
})

test('critical exits only after three samples below 85%', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toCritical(machine, clock)
  assert.equal(machine.state, 'critical')

  assert.equal(feedMany(machine, [84.9, 84.9], clock).length, 0)
  assert.equal(machine.state, 'critical')
  const exit = feedMany(machine, [84.9], clock)
  assert.equal(exit.length, 1)
  assert.equal(exit[0].to, 'warning')
  assert.equal(machine.state, 'warning')
})

test('warning returns to normal only below 75%, not at 76%', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toWarning(machine, clock)
  assert.equal(machine.state, 'warning')
  assert.equal(feedMany(machine, [76, 76, 76], clock).length, 0)
  assert.equal(machine.state, 'warning')
  assert.equal(feedMany(machine, [74.9, 74.9, 74.9], clock).length, 1)
  assert.equal(machine.state, 'normal')
})

test('unknown never becomes normal from a single valid sample', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toCritical(machine, clock)
  clock.advance(5000)
  const lost = machine.markUnavailable('invalid-sample', clock.now)
  assert.equal(lost.to, 'unknown')
  assert.equal(machine.state, 'unknown')

  assert.equal(feedMany(machine, [60], clock).length, 0)
  assert.equal(machine.state, 'unknown')
  assert.equal(feedMany(machine, [60], clock).length, 0)
  assert.equal(machine.state, 'unknown')
  const recovered = feedMany(machine, [60], clock)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].to, 'normal')
})

test('an invalid sample always drops the machine to unknown', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toWarning(machine, clock)
  const transition = machine.feed({ ts: clock.now, commitUsed: 1, commitLimit: 0 }, clock.now)
  assert.equal(transition.to, 'unknown')
  assert.equal(machine.reason, 'invalid-sample')
})

test('episodes get a new id on every critical entry and clear on normal', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  toCritical(machine, clock)
  const first = machine.episodeId
  assert.match(first, /^\d+-1$/)

  feedMany(machine, [80, 80, 80], clock)
  assert.equal(machine.state, 'warning')
  assert.equal(machine.episodeId, first)

  feedMany(machine, [70, 70, 70], clock)
  assert.equal(machine.state, 'normal')
  assert.equal(machine.episodeId, null)

  feedMany(machine, [82, 82, 82], clock)
  feedMany(machine, [96, 96, 96], clock)
  assert.equal(machine.state, 'critical')
  assert.match(machine.episodeId, /^\d+-2$/)
})

test('unknown stays unknown under critical pressure until a calm window is confirmed', () => {
  const clock = makeClock()
  const machine = new PressureMachine({ now: () => clock.now })
  feedMany(machine, [96, 96, 96, 96, 96], clock)
  assert.equal(machine.state, 'unknown')
  assert.equal(machine.episodeId, null)
})

test('confirm sample count is the documented three', () => {
  assert.equal(CONFIRM_SAMPLES, 3)
})
