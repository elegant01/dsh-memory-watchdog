import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { CollectorSupervisor } from '../lib/collector.js'
import { COLLECTOR_BACKOFF_MS } from '../lib/constants.js'
import { powerShellPath } from '../lib/ps.js'
import { GIB } from './helpers.js'

const scriptPath = fileURLToPath(new URL('../lib/resources/collector.ps1', import.meta.url))
const windows = process.platform === 'win32'
const limit = 16 * GIB

function sampleLine(pct = 50) {
  return `${JSON.stringify({
    ok: true,
    ts: 1000,
    commitUsed: Math.round((limit * pct) / 100),
    commitLimit: limit,
    physicalTotal: 32 * GIB,
    physicalAvailable: 8 * GIB,
  })}\n`
}

function fakeChild(pid = 900) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.killed = false
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.unref = () => {}
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    child.exitCode = 0
    child.emit('close', 0, null)
  }
  return child
}

function harness({ spawnImpl } = {}) {
  const spawnCalls = []
  const timers = []
  const samples = []
  const errors = []
  const recovered = []
  const states = []
  const children = []
  const env = { ...process.env }
  const spawnProcess = (file, args, options) => {
    const child = spawnImpl ? spawnImpl(spawnCalls.length, { file, args, options }) : fakeChild(900 + spawnCalls.length)
    spawnCalls.push({ file, args, options, child })
    children.push(child)
    return child
  }
  const collector = new CollectorSupervisor({
    scriptPath,
    env,
    spawnProcess,
    onSample: (sample) => samples.push(sample),
    onError: (error) => errors.push(error),
    onRecovered: (event) => recovered.push(event),
    onStateChange: (state) => states.push(state),
    setTimeoutFn: (fn, ms) => {
      const record = { fn, ms, cleared: false }
      timers.push(record)
      return record
    },
    clearTimeoutFn: (record) => {
      record.cleared = true
    },
    stopTimeoutMs: 10,
  })
  return { collector, spawnCalls, timers, samples, errors, recovered, states, children, env }
}

test('collector spawns the fixed PowerShell path with shell disabled', { skip: !windows }, () => {
  const h = harness()
  h.collector.start()
  assert.equal(h.spawnCalls.length, 1)
  const call = h.spawnCalls[0]
  assert.equal(call.file, powerShellPath(h.env))
  assert.deepEqual(call.args, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-IntervalMs',
    '5000',
  ])
  assert.equal(call.options.shell, false)
  assert.equal(call.options.windowsHide, true)
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(h.collector.state().running, true)
  assert.equal(h.collector.state().pid, call.child.pid)
  h.collector.stop()
})

test('parses streamed sample lines and reports recovery', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  const child = h.spawnCalls[0].child
  child.stdout.emit('data', sampleLine(40) + sampleLine(60))
  assert.equal(h.samples.length, 2)
  assert.equal(h.samples[1].commitUsed, Math.round((limit * 60) / 100))

  child.stderr.emit('data', 'a warning\n')
  assert.equal(h.errors.at(-1).kind, 'stderr')
  child.stdout.emit('data', sampleLine(30))
  assert.equal(h.recovered.length, 1)
  await h.collector.stop()
})

test('restarts after five consecutive malformed lines', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  const child = h.spawnCalls[0].child
  for (let i = 0; i < 4; i += 1) child.stdout.emit('data', 'garbage\n')
  assert.equal(child.killed, false)
  assert.equal(h.collector.state().restarts, 0)

  child.stdout.emit('data', 'garbage\n')
  assert.equal(child.killed, true)
  assert.equal(h.collector.state().restarts, 1)
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, COLLECTOR_BACKOFF_MS[0])
  assert.equal(h.collector.state().nextRestartInMs, COLLECTOR_BACKOFF_MS[0])
  assert.ok(h.errors.some((error) => error.kind === 'malformed'))
  await h.collector.stop()
})

test('a valid sample resets the malformed counter', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  const child = h.spawnCalls[0].child
  for (let i = 0; i < 4; i += 1) child.stdout.emit('data', 'garbage\n')
  child.stdout.emit('data', sampleLine())
  for (let i = 0; i < 4; i += 1) child.stdout.emit('data', 'garbage\n')
  assert.equal(child.killed, false)
  assert.equal(h.collector.state().restarts, 0)
  await h.collector.stop()
})

test('an unexpected exit backs off up to the cap', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  for (let i = 0; i < COLLECTOR_BACKOFF_MS.length + 2; i += 1) {
    const child = h.spawnCalls.at(-1).child
    child.emit('close', 1, null)
    const timer = h.timers.at(-1)
    assert.equal(timer.ms, COLLECTOR_BACKOFF_MS[Math.min(i, COLLECTOR_BACKOFF_MS.length - 1)])
    timer.fn()
  }
  const delays = h.timers.map((timer) => timer.ms)
  assert.deepEqual(delays.slice(0, COLLECTOR_BACKOFF_MS.length), COLLECTOR_BACKOFF_MS)
  assert.equal(delays.at(-1), COLLECTOR_BACKOFF_MS.at(-1))
  await h.collector.stop()
})

test('a spawn error clears the child and schedules a restart', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  const child = h.spawnCalls[0].child
  child.exitCode = null
  child.emit('error', new Error('spawn ENOENT'))
  assert.equal(h.collector.state().running, false)
  assert.equal(h.collector.state().lastExit.signal, 'spawn-error')
  assert.ok(h.errors.some((error) => error.kind === 'spawn-failed'))
  assert.equal(h.timers.length, 1)
  await h.collector.stop()
})

test('stop clears the restart timer, kills the child and blocks restarts', { skip: !windows }, async () => {
  const h = harness()
  h.collector.start()
  const child = h.spawnCalls[0].child
  child.emit('close', 1, null)
  assert.equal(h.timers.length, 1)
  await h.collector.stop()
  assert.equal(h.timers[0].cleared, true)
  assert.equal(h.collector.state().restarts, 1)
  assert.equal(h.collector.state().nextRestartInMs, null)
  h.collector.start()
  assert.equal(h.spawnCalls.length, 1)
})

test('missing or unavailable helpers are reported without spawning', () => {
  const missingScript = new CollectorSupervisor({
    scriptPath: 'definitely-missing.ps1',
    env: {},
    spawnProcess: () => {
      throw new Error('must not spawn')
    },
  })
  const missing = []
  missingScript.onError = (error) => missing.push(error)
  assert.equal(missingScript.start(), undefined)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].kind, 'missing-script')

  const missingShell = new CollectorSupervisor({
    scriptPath,
    env: { SystemRoot: 'C:\\definitely-missing-root' },
    spawnProcess: () => {
      throw new Error('must not spawn')
    },
  })
  const shellErrors = []
  missingShell.onError = (error) => shellErrors.push(error)
  missingShell.start()
  assert.equal(shellErrors.length, 1)
  assert.equal(shellErrors[0].kind, 'missing-powershell')
})
