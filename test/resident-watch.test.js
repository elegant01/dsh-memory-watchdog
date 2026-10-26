import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotifyResident, trackResidents } from '../lib/resident-watch.js'
import { resolveThresholds } from '../lib/thresholds.js'

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const BASE = 1_700_000_000_000

const thresholds = resolveThresholds({})

function rows(list) {
  return { ok: true, at: null, top: list.map(([pid, mb, extra = {}]) => ({ pid, name: extra.name ?? 'node.exe', bytes: mb * MIB, dsh: extra.dsh === true, exePath: extra.exePath ?? null, ageMin: extra.ageMin ?? null })) }
}

function sample(at, list) {
  return { ...rows(list), at }
}

test('nothing is flagged on the first sighting', () => {
  const result = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 2048]]), thresholds })
  assert.deepEqual(result.alerts, [])
  assert.equal(result.tracked[1].baseBytes, 2048 * MIB)
})

test('processes below the one GiB floor are not tracked', () => {
  const result = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 900]]), thresholds })
  assert.deepEqual(Object.keys(result.tracked), [])
  assert.deepEqual(result.alerts, [])
})

test('growth inside the five minute window does not count yet', () => {
  const first = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 2048]]), thresholds })
  const second = trackResidents({ tracked: first.tracked, attribution: sample(BASE + 4 * 60 * 1000, [[1, 4096]]), thresholds })
  assert.deepEqual(second.alerts, [])
  assert.equal(second.tracked[1].baseBytes, 2048 * MIB)
})

test('growth past the threshold raises one alert and re-baselines', () => {
  const first = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 2048, { name: 'node.exe' }]]), thresholds })
  const second = trackResidents({
    tracked: first.tracked,
    attribution: sample(BASE + 6 * 60 * 1000, [[1, 3072, { name: 'node.exe', exePath: 'E:\\nodejs\\node.exe', ageMin: 42 }]]),
    thresholds,
  })
  assert.equal(second.alerts.length, 1)
  const alert = second.alerts[0]
  assert.equal(alert.pid, 1)
  assert.equal(alert.name, 'node.exe')
  assert.equal(alert.bytes, 3 * GIB)
  assert.equal(alert.growthBytes, 1024 * MIB)
  assert.equal(alert.spanMs, 6 * 60 * 1000)
  assert.equal(alert.exePath, 'E:\\nodejs\\node.exe')
  assert.equal(alert.ageMin, 42)
  assert.equal(alert.dsh, false)
  assert.equal(second.tracked[1].baseBytes, 3 * GIB, 'the baseline moves to the new value')

  const third = trackResidents({ tracked: second.tracked, attribution: sample(BASE + 12 * 60 * 1000, [[1, 3500]]), thresholds })
  assert.deepEqual(third.alerts, [], 'a second jump smaller than the threshold stays quiet')
})

test('released memory re-baselines downward', () => {
  const first = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 4096]]), thresholds })
  const second = trackResidents({ tracked: first.tracked, attribution: sample(BASE + 10 * 60 * 1000, [[1, 1500]]), thresholds })
  assert.deepEqual(second.alerts, [])
  assert.equal(second.tracked[1].baseBytes, 1500 * MIB)
})

test('processes that leave the list stop being tracked', () => {
  const first = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 2048], [2, 3072]]), thresholds })
  const second = trackResidents({ tracked: first.tracked, attribution: sample(BASE + 6 * 60 * 1000, [[1, 2048]]), thresholds })
  assert.deepEqual(Object.keys(second.tracked), ['1'])
})

test('a failed attribution sample clears nothing but raises nothing', () => {
  const first = trackResidents({ tracked: {}, attribution: sample(BASE, [[1, 2048]]), thresholds })
  const broken = trackResidents({ tracked: first.tracked, attribution: { ok: false, top: [] }, thresholds })
  assert.deepEqual(broken.alerts, [])
  assert.deepEqual(broken.tracked, {})
  assert.deepEqual(trackResidents({ tracked: {}, attribution: null, thresholds }).tracked, {})
})

test('alerts are rate limited per pid', () => {
  const cooldowns = { 7: BASE }
  assert.equal(shouldNotifyResident(cooldowns, 7, BASE + 29 * 60 * 1000, thresholds.residentNoticeMs), false)
  assert.equal(shouldNotifyResident(cooldowns, 7, BASE + 31 * 60 * 1000, thresholds.residentNoticeMs), true)
  assert.equal(shouldNotifyResident(cooldowns, 8, BASE, thresholds.residentNoticeMs), true)
})

test('the growth threshold is configurable and clamped', () => {
  assert.equal(thresholds.residentGrowMb, 512)
  assert.equal(thresholds.residentMinBytes, GIB)
  assert.equal(thresholds.residentWindowMs, 5 * 60 * 1000)
  const tuned = resolveThresholds({ residentGrowMb: 100000 })
  assert.equal(tuned.residentGrowMb, 8192)
  assert.equal(tuned.residentGrowBytes, 8192 * MIB)
})
