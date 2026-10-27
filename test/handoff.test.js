import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HandoffManager, validateInspect } from '../lib/handoff.js'
import { makeTempDir, settle } from './helpers.js'

const HOST_PID = 100
const MAIN_EXE = 'C:\\Program Files\\DSH\\DSH.exe'

function inspectValue(overrides = {}) {
  return {
    ok: true,
    host: { pid: HOST_PID, creationTime: 111, exe: MAIN_EXE },
    main: {
      pid: 200,
      creationTime: 222,
      exe: MAIN_EXE,
      argv: ['DSH.exe', '--profile', 'desktop'],
      cwd: 'C:\\Program Files\\DSH',
    },
    mainIsParent: true,
    sameExe: true,
    hostLooksDesktop: true,
    mainLooksDesktop: true,
    probeAccess: { main: true, host: true },
    sameExeDescendants: [{ pid: 300, creationTime: 333, exe: MAIN_EXE }],
    ...overrides,
  }
}

function fakeChild(pid = 555) {
  return {
    pid,
    exitCode: null,
    killed: false,
    unref() {},
    kill() {
      this.killed = true
      this.exitCode = 0
    },
  }
}

function makeManager(temp, { inspect = inspectValue(), spawnProcess, now = 1_000_000, verifyTimeoutMs } = {}) {
  const spawnCalls = []
  const manager = new HandoffManager({
    guardDir: temp.dir,
    helperPath: 'C:\\plugin\\lib\\resources\\helper.mjs',
    inspectScript: 'C:\\plugin\\lib\\resources\\inspect.ps1',
    runJson: async () => ({ ok: true, value: inspect }),
    spawnProcess: spawnProcess ?? ((file, args, options) => {
      const child = fakeChild()
      spawnCalls.push({ file, args, options, child })
      return child
    }),
    now: () => now,
    version: '0.1.0',
    env: { PATH: 'C:\\Windows' },
    hostPid: HOST_PID,
    portProvider: () => 19387,
    verifyTimeoutMs: verifyTimeoutMs ?? 1000,
  })
  return { manager, spawnCalls }
}

function tamper(mutate) {
  const value = inspectValue()
  mutate(value)
  return value
}

test('validateInspect accepts a complete desktop process tree', () => {
  const result = validateInspect(inspectValue(), { hostPid: HOST_PID })
  assert.equal(result.ok, true)
  assert.equal(result.host.pid, HOST_PID)
  assert.equal(result.main.pid, 200)
  assert.deepEqual(result.targets, [{ pid: 300, creationTime: 333, exe: MAIN_EXE }])
})

test('validateInspect rejects every incomplete or inconsistent shape', () => {
  const cases = [
    [null, /inspect failed/],
    [{ ok: false, error: 'access denied' }, /inspect failed: access denied/],
    [tamper((v) => { v.host.pid = 999 }), /Host identity mismatch/],
    [tamper((v) => { v.host.creationTime = 0 }), /Host identity is incomplete/],
    [tamper((v) => { v.host.exe = '' }), /Host identity is incomplete/],
    [tamper((v) => { v.main.pid = 0 }), /Electron main process was not resolved/],
    [tamper((v) => { v.main.creationTime = null }), /Electron main identity is incomplete/],
    [tamper((v) => { v.main.argv = [] }), /command line was not readable/],
    [tamper((v) => { v.mainIsParent = false }), /not a child of the Electron main/],
    [tamper((v) => { v.sameExe = false }), /executables differ/],
    [tamper((v) => { v.hostLooksDesktop = false }), /does not look like DSH Desktop Host/],
    [tamper((v) => { v.mainLooksDesktop = false }), /does not look like the Electron main/],
    [tamper((v) => { v.probeAccess.main = false }), /cannot open the Electron main/],
    [tamper((v) => { v.probeAccess.host = false }), /cannot open the Host/],
    [tamper((v) => { v.sameExeDescendants = null }), /descendant list is missing/],
    [tamper((v) => { v.sameExeDescendants = [{ pid: 'x' }] }), /descendant record is malformed/],
  ]
  for (const [value, pattern] of cases) {
    const result = validateInspect(value, { hostPid: HOST_PID })
    assert.equal(result.ok, false, String(pattern))
    assert.match(result.reason, pattern)
  }
})

test('prepare writes a complete request, cleans old handoffs and spawns the helper', async () => {
  const temp = await makeTempDir()
  await mkdir(join(temp.dir, 'handoff', 'old-run'), { recursive: true })
  await writeFile(join(temp.dir, 'handoff', 'old-run', 'request.json'), '{}')
  const { manager, spawnCalls } = makeManager(temp)

  const result = await manager.prepare({ trigger: { episodeId: 'episode-1' } })
  assert.equal(result.ok, true)
  assert.equal(spawnCalls.length, 1)

  const request = JSON.parse(await readFile(join(result.handoffDir, 'request.json'), 'utf8'))
  assert.equal(request.version, 1)
  assert.equal(request.createdAt, 1_000_000)
  assert.equal(request.hostPid, HOST_PID)
  assert.equal(request.hostCreationTime, 111)
  assert.equal(request.mainPid, 200)
  assert.equal(request.mainCreationTime, 222)
  assert.deepEqual(request.mainArgv, ['DSH.exe', '--profile', 'desktop'])
  assert.equal(request.mainCwd, 'C:\\Program Files\\DSH')
  assert.equal(request.port, 19387)
  assert.deepEqual(request.trigger, { episodeId: 'episode-1' })
  assert.deepEqual(
    request.targets.map((target) => target.pid).sort((a, b) => a - b),
    [100, 200, 300],
  )

  const call = spawnCalls[0]
  assert.equal(call.file, process.execPath)
  assert.deepEqual(call.args, [manager.helperPath, result.handoffDir])
  assert.equal(call.options.detached, true)
  assert.equal(call.options.shell, false)
  assert.equal(call.options.stdio, 'ignore')
  assert.equal(call.options.cwd, temp.dir)
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(manager.child, call.child)

  const entries = await readFile(join(temp.dir, 'handoff', 'old-run', 'request.json'), 'utf8').catch(() => null)
  assert.equal(entries, null)
  await temp.cleanup()
})

test('prepare stops before spawning when the Host cannot be inspected', async () => {
  const temp = await makeTempDir()
  const { manager, spawnCalls } = makeManager(temp, { spawnProcess: () => { throw new Error('must not spawn') } })
  manager.runJson = async () => ({ ok: false, error: 'access denied' })
  const result = await manager.prepare()
  assert.deepEqual(result, { ok: false, reason: 'access denied' })
  assert.equal(spawnCalls.length, 0)
  assert.equal(manager.handoffDir, null)
  await temp.cleanup()
})

test('prepare fails closed when the helper cannot be spawned', async () => {
  const temp = await makeTempDir()
  const { manager } = makeManager(temp, {
    spawnProcess: () => {
      throw new Error('spawn failed')
    },
  })
  const result = await manager.prepare()
  assert.equal(result.ok, false)
  assert.match(result.reason, /spawn failed/)
  assert.equal(manager.child, null)
  await temp.cleanup()
})

test('waitForVerified and waitForFrozen read markers and fail closed', async () => {
  const temp = await makeTempDir()
  const { manager } = makeManager(temp)
  manager.handoffDir = temp.dir

  await writeFile(join(temp.dir, 'verified.json'), JSON.stringify({ ok: true }))
  assert.equal((await manager.waitForVerified()).status, 'verified')

  await writeFile(join(temp.dir, 'frozen.json'), JSON.stringify({ ok: true }))
  assert.equal((await manager.waitForFrozen()).status, 'frozen')

  await writeFile(join(temp.dir, 'verified.json'), JSON.stringify({ ok: false }))
  assert.equal((await manager.waitForVerified()).status, 'failed')

  await rm(join(temp.dir, 'frozen.json'))
  await writeFile(join(temp.dir, 'failed.json'), JSON.stringify({ ok: false, reason: 'identity changed' }))
  const failed = await manager.waitForFrozen()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.value.reason, 'identity changed')
  await temp.cleanup()
})

test('waitForVerified times out when no marker appears', async () => {
  const temp = await makeTempDir()
  const { manager } = makeManager(temp, { verifyTimeoutMs: 0 })
  manager.handoffDir = temp.dir
  const result = await manager.waitForVerified()
  assert.equal(result.status, 'timeout')
  assert.match(result.error, /timed out/)
  await temp.cleanup()
})

test('writeGo records the gate and abort records the reason', async () => {
  const temp = await makeTempDir()
  const { manager } = makeManager(temp)
  manager.handoffDir = temp.dir

  await manager.writeGo()
  const go = JSON.parse(await readFile(join(temp.dir, 'go.json'), 'utf8'))
  assert.equal(go.at, 1_000_000)

  manager.child = fakeChild()
  manager.child.exitCode = 0
  await manager.abort('user canceled')
  const abort = JSON.parse(await readFile(join(temp.dir, 'abort.json'), 'utf8'))
  assert.equal(abort.reason, 'user canceled')
  assert.equal(abort.at, 1_000_000)
  await temp.cleanup()
})

test('killSpawned only signals a running child', () => {
  const { manager } = makeManager({ dir: 'C:\\unused' })
  const running = fakeChild()
  manager.killSpawned(running)
  assert.equal(running.killed, true)

  const finished = fakeChild()
  finished.exitCode = 0
  manager.killSpawned(finished)
  assert.equal(finished.killed, false)

  manager.killSpawned(null)
  manager.killSpawned(undefined)
})

test('checkCapability reads the helper marker and maps failures', async () => {
  const temp = await makeTempDir()
  const calls = []
  let payload = { ok: true, checkedAt: 123, pid: 777, mainPid: 200, inJob: false }
  const { manager } = makeManager(temp, {
    spawnProcess: (file, args, options) => {
      const child = fakeChild()
      calls.push({ file, args, options, child })
      writeFileSync(args[2], JSON.stringify(payload))
      return child
    },
  })

  const ok = await manager.checkCapability({ timeoutMs: 1000 })
  assert.deepEqual(ok, { ok: true, reason: null, checkedAt: 123, helperPid: 777, mainPid: 200, inJob: false, escape: 'none' })
  assert.deepEqual(calls[0].args.slice(1), ['--capability', join(temp.dir, 'capability.json')])
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1')

  payload = { ok: true, checkedAt: 123, pid: 777, mainPid: 200, inJob: true, escape: 'breakaway' }
  const escaped = await manager.checkCapability({ timeoutMs: 1000 })
  assert.equal(escaped.ok, true)
  assert.equal(escaped.inJob, true)
  assert.equal(escaped.escape, 'breakaway')

  payload = { ok: false, checkedAt: 456, reason: 'helper is inside a job', inJob: true }
  const failed = await manager.checkCapability({ timeoutMs: 1000 })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'helper is inside a job')
  assert.equal(failed.inJob, true)
  assert.equal(failed.checkedAt, 456)

  payload = { ok: false }
  const fallback = await manager.checkCapability({ timeoutMs: 1000 })
  assert.equal(fallback.reason, 'capability check failed')
  await temp.cleanup()
})

test('checkCapability times out and kills the helper', async () => {
  const temp = await makeTempDir()
  const { manager } = makeManager(temp, {
    spawnProcess: () => fakeChild(),
  })
  const result = await manager.checkCapability({ timeoutMs: 0 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /timed out/)
  assert.equal(result.checkedAt, 1_000_000)
  assert.equal(manager.child, null)
  await temp.cleanup()
})

test('waitForChildExit returns immediately for an exited child', async () => {
  const { manager } = makeManager({ dir: 'C:\\unused' })
  manager.child = fakeChild()
  manager.child.exitCode = 0
  assert.equal(await manager.waitForChildExit(1), true)
  manager.child = null
  assert.equal(await manager.waitForChildExit(1), true)
  await settle()
})
