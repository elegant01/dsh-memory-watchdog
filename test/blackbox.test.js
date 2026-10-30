import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createBlackbox } from '../lib/blackbox.js'
import { makeTempDir } from './helpers.js'

function sample(at, pct) {
  return { at, pct, used: pct * 10, limit: 1000, rss: 1024, heapUsed: 512, state: 'normal' }
}

test('blackbox keeps the newest points and throttles writes', async () => {
  const dir = await makeTempDir()
  try {
    let clock = 10_000
    const box = createBlackbox({ dir: dir.dir, now: () => clock, intervalMs: 4_000, points: 3 })
    assert.equal(await box.load(), null)

    assert.equal(box.push(sample(clock, 10)), true)
    clock += 1_000
    assert.equal(box.push(sample(clock, 20)), false, 'pushes inside the throttle window are skipped')
    clock += 3_500
    assert.equal(box.push(sample(clock, 30)), true)
    clock += 4_000
    box.push(sample(clock, 40))
    clock += 4_000
    box.push(sample(clock, 50))
    await box.dispose()

    const stored = JSON.parse(await readFile(box.path, 'utf8'))
    assert.equal(stored.samples.length, 3)
    assert.deepEqual(stored.samples.map((entry) => entry.pct), [30, 40, 50])
    const status = box.status()
    assert.equal(status.samples.length, 3)
    assert.equal(status.previous, null)
  } finally {
    await dir.cleanup()
  }
})

test('a blackbox written by another process shows up as the previous run', async () => {
  const dir = await makeTempDir()
  try {
    const box = createBlackbox({ dir: dir.dir, now: () => 9_000, intervalMs: 0, points: 4 })
    await writeFile(
      box.path,
      JSON.stringify({
        version: 1,
        pid: process.pid + 1,
        startAt: 1_000,
        endAt: 5_000,
        samples: [sample(4_000, 91), sample(5_000, 95)],
      }),
      'utf8'
    )

    const previous = await box.load()
    assert.notEqual(previous, null)
    assert.deepEqual(previous.samples.map((entry) => entry.pct), [91, 95])
    assert.equal(previous.endAt, 5_000)
    assert.equal(previous.pid, process.pid + 1)
    const status = previous === null ? null : box.status()
    assert.equal(status.previous.samples.length, 2)
    assert.equal(status.samples.length, 0)
    await box.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('a blackbox written by the same process is never treated as a crash', async () => {
  const dir = await makeTempDir()
  try {
    const first = createBlackbox({ dir: dir.dir, now: () => 1_000, intervalMs: 0, points: 4 })
    first.push(sample(900, 50))
    await first.dispose()

    const samePid = createBlackbox({ dir: dir.dir, now: () => 2_000, intervalMs: 0, points: 4 })
    assert.equal(await samePid.load(), null, 'a hot reload of this plugin keeps the same pid')
    await samePid.dispose()
  } finally {
    await dir.cleanup()
  }
})

test('a corrupt blackbox file degrades to no record', async () => {
  const dir = await makeTempDir()
  try {
    const box = createBlackbox({ dir: dir.dir, now: () => 1_000 })
    await writeFile(box.path, '{ not json', 'utf8')
    assert.equal(await box.load(), null)
    assert.equal(typeof box.status().error, 'string')
    await box.dispose()
  } finally {
    await dir.cleanup()
  }
})