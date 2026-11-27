import test from 'node:test'
import assert from 'node:assert/strict'
import { createIncident, normalizeIncidents, summarizeAttribution } from '../lib/incidents.js'
import { GuardStore } from '../lib/store.js'
import { makeTempDir } from './helpers.js'

const GIB = 1024 ** 3
const NOW = 1_700_000_000_000

function attribution(at, overrides = {}) {
  return {
    ok: true,
    at,
    sharePct: 72.5,
    dshBytes: 20 * GIB,
    dshCount: 6,
    groups: [
      { name: 'chrome.exe', count: 3, bytes: 8 * GIB, dsh: false, dshBytes: 0 },
      { name: 'DeepSeek Harness.exe', count: 2, bytes: 30 * GIB, dsh: true, dshBytes: 30 * GIB },
    ],
    ...overrides,
  }
}

test('summarizeAttribution marks fresh, stale and missing samples', () => {
  const fresh = summarizeAttribution(attribution(NOW - 30000), NOW)
  assert.equal(fresh.state, 'fresh')
  assert.equal(fresh.attribution.sharePct, 72.5)
  assert.equal(fresh.attribution.groups[0].name, 'DeepSeek Harness.exe')
  assert.equal(fresh.attribution.groups[0].dshBytes, 30 * GIB)

  const stale = summarizeAttribution(attribution(NOW - 10 * 60 * 1000), NOW)
  assert.equal(stale.state, 'stale')
  assert.equal(stale.attribution.ageMs, 10 * 60 * 1000)

  assert.equal(summarizeAttribution(null, NOW).state, 'missing')
  assert.equal(summarizeAttribution({ ok: false }, NOW).state, 'missing')
})

test('createIncident freezes the transition and the visible ranking', () => {
  const incident = createIncident({
    id: 'i-1',
    transition: { from: 'normal', to: 'critical', at: NOW, episodeId: 'e-1' },
    sample: { commitUsed: 95 * GIB, commitLimit: 100 * GIB },
    attribution: attribution(NOW - 1000),
    at: NOW,
  })
  assert.equal(incident.id, 'i-1')
  assert.equal(incident.to, 'critical')
  assert.equal(incident.episodeId, 'e-1')
  assert.equal(incident.pct, 95)
  assert.equal(incident.available, 5 * GIB)
  assert.equal(incident.attributionState, 'fresh')
  assert.equal(incident.attribution.groups.length, 2)
})

test('normalizeIncidents drops entries without a timestamp and caps groups', () => {
  const list = normalizeIncidents({
    items: [
      { id: 'a', at: NOW, to: 'warning', attribution: { at: NOW, groups: new Array(10).fill({ name: 'x', bytes: 1 }) } },
      { id: 'b' },
      null,
    ],
  })
  assert.equal(list.length, 1)
  assert.equal(list[0].attribution.groups.length, 5)
  assert.equal(normalizeIncidents(null).length, 0)
})

test('the store persists incidents across a reload', async () => {
  const temp = await makeTempDir()
  try {
    const store = new GuardStore({ dir: temp.dir, now: () => NOW })
    await store.load()
    const incident = createIncident({
      id: 'i-2',
      transition: { from: 'normal', to: 'warning', at: NOW },
      sample: { commitUsed: 82 * GIB, commitLimit: 100 * GIB },
      attribution: attribution(NOW),
      at: NOW,
    })
    await store.writeIncidents([incident])
    const reopened = new GuardStore({ dir: temp.dir, now: () => NOW })
    await reopened.load()
    assert.equal(reopened.incidents.length, 1)
    assert.equal(reopened.incidents[0].id, 'i-2')
    assert.equal(reopened.incidents[0].attributionState, 'fresh')
  } finally {
    await temp.cleanup()
  }
})
