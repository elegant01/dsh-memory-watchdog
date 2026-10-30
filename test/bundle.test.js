import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createBundle } from '../lib/bundle.js'
import { makeClock, makeTempDir } from './helpers.js'

function stubRuntime({ status, events = [] } = {}) {
  return {
    status: () => status,
    historyItems: (limit) => events.slice(-limit),
  }
}

test('the bundle holds the status summary, the events and the written files', async () => {
  const temp = await makeTempDir()
  const clock = makeClock()
  await mkdir(temp.dir, { recursive: true })
  await writeFile(
    join(temp.dir, 'trend.json'),
    JSON.stringify({ version: 1, updatedAt: clock.now, buckets: [{ at: clock.now, n: 3, max: 82 }] }),
    'utf8',
  )
  await writeFile(
    join(temp.dir, 'plugin-memory.json'),
    JSON.stringify({ version: 1, updatedAt: clock.now, windows: [{ at: clock.now, totalBytes: 512, packages: [] }] }),
    'utf8',
  )
  await writeFile(join(temp.dir, 'blackbox.json'), JSON.stringify({ version: 1, points: [] }), 'utf8')
  await writeFile(join(temp.dir, 'capability.json'), JSON.stringify({ state: 'ok' }), 'utf8')

  const runtime = stubRuntime({
    status: { ok: true, plugin: { name: 'dsh-memory-watchdog', version: '0.5.0' }, pressure: { state: 'warning', pct: 82 } },
    events: [{ kind: 'pressure-warning', at: clock.now, pct: 82 }],
  })
  const bundle = createBundle({ dir: temp.dir, now: () => clock.now, runtime })
  const result = await bundle.build()

  assert.equal(result.ok, true)
  assert.equal(result.counts.events, 1)
  assert.equal(result.counts.trendBuckets, 1)
  assert.equal(result.counts.pluginWindows, 1)
  assert.match(result.filename, /^dsh-memory-watchdog-diagnostics-.*\.json$/)
  // The timestamp half must not carry `:` or `.`, which Windows rejects in a
  // download name; the trailing extension is the only dot allowed.
  assert.doesNotMatch(result.filename.slice(0, -'.json'.length), /[:.]/)

  const parsed = JSON.parse(result.body)
  assert.equal(parsed.bundle.version, 1)
  assert.deepEqual(parsed.bundle.excluded, ['heap profiles', 'heap snapshots', 'log text'])
  assert.equal(parsed.status.pressure.pct, 82)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.trend.buckets.length, 1)
  assert.equal(parsed.capability.state, 'ok')
  assert.equal(result.bytes, Buffer.byteLength(result.body, 'utf8'))
  await temp.cleanup()
})

test('a missing file becomes a recorded error instead of failing the build', async () => {
  const temp = await makeTempDir()
  const runtime = stubRuntime({ status: { ok: true } })
  const bundle = createBundle({ dir: temp.dir, now: () => 1_700_000_000_000, runtime })
  const result = await bundle.build()

  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.body)
  assert.equal(parsed.trend.ok, false)
  assert.equal(parsed.trend.error, 'not written yet')
  assert.equal(parsed.pluginMemory.ok, false)
  assert.equal(result.counts.trendBuckets, 0)
  await temp.cleanup()
})

test('a throwing status is captured rather than aborting the bundle', async () => {
  const temp = await makeTempDir()
  const runtime = {
    status: () => {
      throw new Error('status exploded')
    },
    historyItems: () => [],
  }
  const bundle = createBundle({ dir: temp.dir, now: () => 1_700_000_000_000, runtime })
  const result = await bundle.build()

  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.body)
  assert.equal(parsed.status, null)
  assert.equal(parsed.statusError, 'status exploded')
  await temp.cleanup()
})

test('user paths never survive into the bundle body', async () => {
  const temp = await makeTempDir()
  const clock = makeClock()
  await writeFile(
    join(temp.dir, 'plugin-memory.json'),
    JSON.stringify({
      version: 1,
      windows: [
        {
          at: clock.now,
          totalBytes: 512,
          packages: [{ key: 'x', top: [{ file: 'C:\\Users\\alice\\plugin\\lib\\index.js', line: 12, bytes: 64 }] }],
        },
      ],
    }),
    'utf8',
  )
  const runtime = stubRuntime({
    status: { ok: true, system: { pagefiles: [{ path: 'C:\\Users\\alice\\pagefile.sys', used: 1 }] } },
    events: [{ kind: 'restart-attempt', at: clock.now, file: '/home/bob/state.json' }],
  })
  const bundle = createBundle({ dir: temp.dir, now: () => clock.now, runtime })
  const result = await bundle.build()

  assert.doesNotMatch(result.body, /alice/)
  assert.doesNotMatch(result.body, /bob/)
  assert.match(result.body, /~\\\\plugin\\\\lib\\\\index\.js/)
  const parsed = JSON.parse(result.body)
  assert.equal(parsed.pluginMemory.windows[0].packages[0].top[0].file, '~\\plugin\\lib\\index.js')
  assert.equal(parsed.status.system.pagefiles[0].path, '~\\pagefile.sys')
  assert.equal(parsed.events[0].file, '~/state.json')
  await temp.cleanup()
})

test('session ids in the status are shortened', async () => {
  const temp = await makeTempDir()
  const runtime = stubRuntime({ status: { ok: true, sessionId: '0123456789abcdef' }, events: [] })
  const bundle = createBundle({ dir: temp.dir, now: () => 1_700_000_000_000, runtime })
  const result = await bundle.build()

  const parsed = JSON.parse(result.body)
  // `statusSummary` is a whitelist, so the raw id is not even copied over.
  assert.equal(parsed.status.sessionId, undefined)
  assert.doesNotMatch(result.body, /0123456789abcdef/)
  await temp.cleanup()
})
