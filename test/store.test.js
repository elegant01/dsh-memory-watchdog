import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GuardStore } from '../lib/store.js'
import { HISTORY_LIMIT, STORE_VERSION } from '../lib/constants.js'
import { makeTempDir } from './helpers.js'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('a fresh store loads defaults without errors', async () => {
  const temp = await makeTempDir()
  const store = new GuardStore({ dir: temp.dir, now: () => 1000 })
  const loaded = await store.load()
  assert.deepEqual(loaded.errors, [])
  assert.deepEqual(store.state, {
    version: STORE_VERSION,
    cooldownUntil: 0,
    lastAttemptAt: 0,
    attemptedEpisodeId: null,
  })
  assert.equal(store.lastEvent, null)
  assert.equal(store.lastRestart, null)
  assert.equal(store.capability, null)
  assert.equal(store.cooldownActive(), false)
  await temp.cleanup()
})

test('cooldown state persists across instances', async () => {
  const temp = await makeTempDir()
  const first = new GuardStore({ dir: temp.dir, now: () => 1000 })
  await first.load()
  await first.setCooldown({ until: 5000, at: 1000, episodeId: 'episode-1' })
  assert.equal(first.cooldownActive(4000), true)
  assert.equal(first.cooldownActive(6000), false)
  assert.equal(first.cooldownRemaining(4000), 1000)

  const second = new GuardStore({ dir: temp.dir, now: () => 2000 })
  const loaded = await second.load()
  assert.deepEqual(loaded.errors, [])
  assert.equal(second.state.cooldownUntil, 5000)
  assert.equal(second.state.lastAttemptAt, 1000)
  assert.equal(second.state.attemptedEpisodeId, 'episode-1')
  await temp.cleanup()
})

test('last event, restart and capability records persist', async () => {
  const temp = await makeTempDir()
  const first = new GuardStore({ dir: temp.dir })
  await first.load()
  await first.recordEvent({ version: 1, kind: 'pressure-warning', at: 10 })
  await first.writeCapability({ ok: true, checkedAt: 20 })
  await writeFile(join(temp.dir, 'last-restart.json'), JSON.stringify({ status: 'succeeded', finishedAt: 30 }))

  const second = new GuardStore({ dir: temp.dir })
  await second.load()
  assert.deepEqual(second.lastEvent, { version: 1, kind: 'pressure-warning', at: 10 })
  assert.deepEqual(second.capability, { ok: true, checkedAt: 20 })
  assert.deepEqual(second.lastRestart, { status: 'succeeded', finishedAt: 30 })

  await writeFile(join(temp.dir, 'last-restart.json'), JSON.stringify({ status: 'failed', finishedAt: 40 }))
  assert.deepEqual(await second.refreshRestart(), { status: 'failed', finishedAt: 40 })
  assert.deepEqual(second.lastRestart, { status: 'failed', finishedAt: 40 })
  await temp.cleanup()
})

test('corrupt files are reported and replaced by safe defaults', async () => {
  const temp = await makeTempDir()
  await writeFile(join(temp.dir, 'state.json'), '{not json')
  await writeFile(join(temp.dir, 'last-event.json'), '[[')
  await writeFile(join(temp.dir, 'last-restart.json'), '{')
  await writeFile(join(temp.dir, 'capability.json'), 'oops')
  await writeFile(join(temp.dir, 'events.json'), '[[')

  const store = new GuardStore({ dir: temp.dir })
  const loaded = await store.load()
  assert.deepEqual(
    loaded.errors.map((entry) => entry.file).sort(),
    ['capability.json', 'events.json', 'last-event.json', 'last-restart.json', 'state.json'],
  )
  assert.equal(store.state.cooldownUntil, 0)
  assert.equal(store.state.attemptedEpisodeId, null)
  assert.equal(store.lastEvent, null)
  assert.equal(store.lastRestart, null)
  assert.equal(store.capability, null)
  await temp.cleanup()
})

test('event history is capped, queryable and persists across instances', async () => {
  const temp = await makeTempDir()
  const first = new GuardStore({ dir: temp.dir })
  await first.load()
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    await first.recordEvent({ version: 1, kind: 'event', at: i })
  }
  assert.equal(first.history.length, HISTORY_LIMIT)
  assert.equal(first.history[0].at, 5)
  assert.deepEqual(first.historyItems(2).map((entry) => entry.at), [HISTORY_LIMIT + 3, HISTORY_LIMIT + 4])
  assert.deepEqual(first.historyItems(0), [])

  const second = new GuardStore({ dir: temp.dir })
  await second.load()
  assert.equal(second.history.length, HISTORY_LIMIT)
  assert.deepEqual(second.lastEvent, { version: 1, kind: 'event', at: HISTORY_LIMIT + 4 })
  assert.deepEqual(second.historyItems(1), [{ version: 1, kind: 'event', at: HISTORY_LIMIT + 4 }])
  await temp.cleanup()
})

test('writes are serialized and survive a failed task', async () => {  const temp = await makeTempDir()
  const store = new GuardStore({ dir: temp.dir })
  await store.load()

  await assert.rejects(store.enqueue(() => Promise.reject(new Error('disk full'))), /disk full/)
  const writes = []
  for (let i = 0; i < 20; i += 1) {
    writes.push(store.recordEvent({ version: 1, kind: 'event', at: i }))
    writes.push(store.writeCapability({ ok: i % 2 === 0, checkedAt: i }))
  }
  writes.push(store.setCooldown({ until: 9000, at: 8000, episodeId: 'final' }))
  await Promise.all(writes)
  await store.flush()

  assert.deepEqual(store.lastEvent, { version: 1, kind: 'event', at: 19 })
  assert.deepEqual(store.capability, { ok: false, checkedAt: 19 })
  const state = await readJson(join(temp.dir, 'state.json'))
  assert.equal(state.cooldownUntil, 9000)
  assert.equal(state.attemptedEpisodeId, 'final')
  assert.deepEqual(await readJson(join(temp.dir, 'last-event.json')), store.lastEvent)
  await temp.cleanup()
})
