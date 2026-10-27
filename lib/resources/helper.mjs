import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GO_WAIT_TIMEOUT_MS,
  HOST_EXIT_WAIT_MS,
  MEMORY_RECOVERY_AVAIL_BYTES,
  MEMORY_RECOVERY_PCT,
  MEMORY_RECOVERY_WAIT_MS,
  PORT_RELEASE_WAIT_MS,
  TARGET_EXIT_WAIT_MS,
} from '../constants.js'
import { validateInspect } from '../handoff.js'
import { runPowerShellJson } from '../ps.js'
import { capText, readJsonFile, safeErrorMessage, sleep, writeJsonAtomic } from '../util.js'

const here = dirname(fileURLToPath(import.meta.url))
const jobcheckScript = join(here, 'jobcheck.ps1')
const escapeScript = join(here, 'escape.ps1')
const relaunchScript = join(here, 'relaunch.ps1')
const inspectScript = join(here, 'inspect.ps1')
const freezeScript = join(here, 'freeze.ps1')
const terminateScript = join(here, 'terminate.ps1')
const collectorScript = join(here, 'collector.ps1')

const startedAt = Date.now()
const steps = []
const helperPid = process.pid

function mark(phase, detail = null) {
  steps.push({ phase, at: Date.now(), detail })
}

function printAndExit(code) {
  process.exit(code)
}

async function runJson(script, args, timeoutMs = 20000) {
  return runPowerShellJson({ script, args, timeoutMs, cwd: process.cwd() })
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function writeMarker(dir, name, value) {
  await writeJsonAtomic(join(dir, name), value)
}

function guardDirectoryFor(handoffDir) {
  return resolve(handoffDir, '..', '..')
}

async function writeResult(handoffDir, result) {
  const payload = {
    version: 1,
    status: result.status,
    reason: result.reason ?? null,
    startedAt,
    finishedAt: Date.now(),
    helperPid,
    handoffId: result.handoffId ?? null,
    hostPid: result.hostPid ?? null,
    mainPid: result.mainPid ?? null,
    mainExe: result.mainExe ?? null,
    newPid: result.newPid ?? null,
    memoryBefore: result.memoryBefore ?? null,
    memoryAfter: result.memoryAfter ?? null,
    portListening: result.portListening ?? null,
    trigger: result.trigger ?? null,
    steps,
    error: result.error === undefined ? null : capText(result.error, 1000),
  }
  await writeJsonAtomic(join(handoffDir, 'result.json'), payload).catch(() => {})
  await writeJsonAtomic(join(guardDirectoryFor(handoffDir), 'last-restart.json'), payload).catch(() => {})
  return payload
}

async function selfJobCheck() {
  const result = await runJson(jobcheckScript, ['-ProcessId', String(helperPid)])
  if (!result.ok) {
    return { ok: false, reason: `helper self-check failed: ${result.error}` }
  }
  if (result.value?.ok !== true || typeof result.value.inJob !== 'boolean') {
    return { ok: false, reason: 'helper self-check returned unreadable data' }
  }
  if (!result.value.inJob) {
    return { ok: true, inJob: false, escape: 'none' }
  }
  const probe = await runJson(escapeScript, [])
  if (!probe.ok || probe.value?.ok !== true) {
    const detail = probe.ok ? (probe.value?.error ?? 'unreadable escape probe') : probe.error
    return { ok: false, inJob: true, escape: 'none', reason: `helper is inside a job and the escape probe did not run: ${detail}` }
  }
  const value = probe.value
  if (value.plainInJob === false) {
    return { ok: true, inJob: true, escape: 'silent-breakaway' }
  }
  if (value.breakawayOk === true && value.breakawayInJob === false) {
    return { ok: true, inJob: true, escape: 'breakaway' }
  }
  const jobProbe = {
    plainInJob: value.plainInJob ?? null,
    plainError: value.plainError ?? null,
    breakawayOk: value.breakawayOk === true,
    breakawayInJob: value.breakawayInJob ?? null,
    breakawayError: value.breakawayError ?? null,
  }
  if (value.breakawayOk === true) {
    const reason =
      jobProbe.breakawayInJob === true
        ? 'helper is inside a job that keeps its child processes (breakaway left the child in a job)'
        : 'helper is inside a job and the escape probe returned unreadable data'
    return { ok: false, inJob: true, escape: 'none', jobProbe, reason }
  }
  const failed = Number.isInteger(value.breakawayError)
    ? `CreateProcess error ${value.breakawayError}`
    : (value.error ?? 'unreadable escape probe')
  return { ok: false, inJob: true, escape: 'none', jobProbe, reason: `helper is inside a job and the escape probe did not run: ${failed}` }
}

async function inspectHost(hostPid) {
  const result = await runJson(inspectScript, ['-HostPid', String(hostPid), '-ProbeAccess', '-ExcludePid', String(helperPid)])
  if (!result.ok) return { ok: false, reason: result.error }
  return validateInspect(result.value, { hostPid })
}

function sameIdentity(target, expected) {
  return (
    target !== null &&
    typeof target === 'object' &&
    target.pid === expected.pid &&
    target.creationTime === expected.creationTime &&
    typeof target.exe === 'string' &&
    target.exe.toLowerCase() === String(expected.exe).toLowerCase()
  )
}

async function runCapability(capabilityPath) {
  const self = await selfJobCheck()
  if (!self.ok) {
    await writeJsonAtomic(capabilityPath, {
      ok: false,
      checkedAt: Date.now(),
      pid: helperPid,
      inJob: self.inJob === true,
      escape: self.escape ?? 'none',
      jobProbe: self.jobProbe ?? null,
      reason: self.reason,
    }).catch(() => {})
    return
  }
  mark('self-check', { escape: self.escape })
  const hostPid = process.ppid
  const inspected = await inspectHost(hostPid)
  if (!inspected.ok) {
    await writeJsonAtomic(capabilityPath, {
      ok: false,
      checkedAt: Date.now(),
      pid: helperPid,
      hostPid,
      inJob: self.inJob,
      escape: self.escape,
      reason: inspected.reason,
    }).catch(() => {})
    return
  }
  mark('inspect')
  await writeJsonAtomic(capabilityPath, {
    ok: true,
    checkedAt: Date.now(),
    pid: helperPid,
    hostPid,
    mainPid: inspected.main.pid,
    mainExe: inspected.main.exe,
    inJob: self.inJob,
    escape: self.escape,
    descendants: inspected.targets.length,
  }).catch(() => {})
}

async function waitForGo(handoffDir, hostPid) {
  const deadline = Date.now() + GO_WAIT_TIMEOUT_MS
  for (;;) {
    const abort = await readJsonFile(join(handoffDir, 'abort.json'))
    if (abort.ok) return { status: 'aborted', value: abort.value }
    const go = await readJsonFile(join(handoffDir, 'go.json'))
    if (go.ok) return { status: 'go', value: go.value }
    if (!isAlive(hostPid)) return { status: 'host-gone' }
    if (Date.now() >= deadline) return { status: 'timeout' }
    await sleep(200)
  }
}

async function waitHostExit(hostPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isAlive(hostPid)) {
    if (Date.now() >= deadline) return false
    await sleep(200)
  }
  return true
}

async function waitMainExit(mainPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isAlive(mainPid)) {
    if (Date.now() >= deadline) return false
    await sleep(150)
  }
  return true
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolvePort(false)
      return
    }
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePort(open)
    }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitPortReleased(port, timeoutMs) {
  if (!Number.isInteger(port) || port <= 0) return { ok: true, skipped: true }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return { ok: true, skipped: false }
    await sleep(250)
  }
  return { ok: false, skipped: false }
}

async function readMemory() {
  const result = await runJson(collectorScript, ['-Once'], 15000)
  if (!result.ok || result.value?.ok !== true) return null
  const used = Number(result.value.commitUsed)
  const limit = Number(result.value.commitLimit)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  return {
    commitUsed: used,
    commitLimit: limit,
    pct: (used / limit) * 100,
    available: limit - used,
    physicalTotal: result.value.physicalTotal,
    physicalAvailable: result.value.physicalAvailable,
    at: Date.now(),
  }
}

async function waitMemoryRecovery(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readMemory()
    if (last !== null && (last.pct < MEMORY_RECOVERY_PCT || last.available > MEMORY_RECOVERY_AVAIL_BYTES)) {
      return { ok: true, sample: last }
    }
    await sleep(1000)
  }
  return { ok: false, sample: last }
}

async function terminateTargets(handoffDir, targets) {
  const unique = []
  const seen = new Set()
  for (const target of targets) {
    if (target === null || typeof target !== 'object') continue
    if (!Number.isInteger(target.pid) || target.pid <= 4) continue
    if (target.pid === helperPid) continue
    if (!Number.isFinite(target.creationTime) || target.creationTime <= 0) continue
    if (typeof target.exe !== 'string' || target.exe.length === 0) continue
    if (seen.has(target.pid)) continue
    seen.add(target.pid)
    unique.push({ pid: target.pid, creationTime: target.creationTime, exe: target.exe })
  }
  const alive = unique.filter((target) => isAlive(target.pid))
  const targetsPath = join(handoffDir, 'targets.json')
  await writeJsonAtomic(targetsPath, alive)
  const result = await runJson(terminateScript, ['-TargetsFile', targetsPath], 30000)
  return { ok: result.ok, value: result.value ?? null, error: result.error ?? null, live: alive }
}

function relaunchPlan(request) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const args = Array.isArray(request.mainArgv) ? request.mainArgv.slice(1) : []
  const cwd = typeof request.mainCwd === 'string' && request.mainCwd.length > 0 ? request.mainCwd : dirname(request.mainExe)
  return { exe: request.mainExe, args, cwd, env }
}

async function relaunch(request, escape, workDir) {
  const plan = relaunchPlan(request)
  if (escape === 'breakaway') {
    const requestPath = join(workDir, 'relaunch-request.json')
    const written = await writeJsonAtomic(requestPath, {
      exe: plan.exe,
      args: plan.args,
      cwd: plan.cwd,
      env: Object.entries(plan.env).map(([key, value]) => `${key}=${String(value ?? '')}`),
    }).then(() => true).catch(() => false)
    if (!written) return { ok: false, error: 'the relaunch request could not be written' }
    const result = await runJson(relaunchScript, ['-RequestFile', requestPath], 30000)
    if (!result.ok) return { ok: false, error: result.error }
    const value = result.value ?? {}
    if (value.ok !== true || !Number.isInteger(value.pid)) {
      return { ok: false, error: value.error ?? 'the breakaway relaunch returned unreadable data' }
    }
    return { ok: true, pid: value.pid, escaped: value.inJob === false }
  }
  try {
    const child = spawn(plan.exe, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
      env: plan.env,
    })
    child.unref?.()
    return { ok: true, pid: child.pid ?? null }
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) }
  }
}

async function waitPortListening(port, timeoutMs) {
  if (!Number.isInteger(port) || port <= 0) return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await sleep(300)
  }
  return false
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--capability') {
    const capabilityPath = process.argv[3]
    if (typeof capabilityPath !== 'string' || capabilityPath.length === 0) {
      printAndExit(1)
      return
    }
    await runCapability(capabilityPath)
    printAndExit(0)
    return
  }

  const handoffDir = mode
  if (typeof handoffDir !== 'string' || handoffDir.length === 0) {
    printAndExit(1)
    return
  }
  await mkdir(handoffDir, { recursive: true }).catch(() => {})
  mark('start')

  const self = await selfJobCheck()
  if (!self.ok) {
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason: self.reason })
    await writeResult(handoffDir, { status: 'failed', reason: self.reason })
    printAndExit(0)
    return
  }
  mark('self-check', { escape: self.escape })
  const requestRead = await readJsonFile(join(handoffDir, 'request.json'))
  if (!requestRead.ok) {
    await writeResult(handoffDir, { status: 'failed', reason: 'handoff request is unreadable', error: requestRead.error })
    printAndExit(1)
    return
  }
  const request = requestRead.value
  const hostPid = Number(request?.hostPid)
  if (!Number.isInteger(hostPid) || hostPid !== process.ppid) {
    await writeResult(handoffDir, { status: 'failed', reason: 'handoff request does not belong to the parent Host' })
    printAndExit(1)
    return
  }
  const base = {
    handoffId: handoffDir.split(/[\\/]/).pop(),
    hostPid,
    mainPid: Number(request.mainPid),
    mainExe: String(request.mainExe),
    trigger: request.trigger ?? null,
  }

  const inspected = await inspectHost(hostPid)
  if (!inspected.ok) {
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason: inspected.reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason: inspected.reason })
    printAndExit(0)
    return
  }
  mark('verified-inspect')

  if (!Number.isInteger(request.mainPid) || !Number.isFinite(request.hostCreationTime) || !Number.isFinite(request.mainCreationTime)) {
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason: 'handoff request is incomplete' })
    await writeResult(handoffDir, { ...base, status: 'failed', reason: 'handoff request is incomplete' })
    printAndExit(0)
    return
  }
  if (!sameIdentity(inspected.host, { pid: hostPid, creationTime: request.hostCreationTime, exe: request.hostExe })) {
    const reason = 'Host identity changed since the handoff request'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason })
    printAndExit(0)
    return
  }
  const expectedMain = { pid: request.mainPid, creationTime: request.mainCreationTime, exe: request.mainExe }
  if (!sameIdentity(inspected.main, expectedMain)) {
    const reason = 'Electron main identity changed since the handoff request'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason })
    printAndExit(0)
    return
  }

  await writeMarker(handoffDir, 'verified.json', {
    ok: true,
    at: Date.now(),
    helperPid,
    hostPid,
    mainPid: inspected.main.pid,
    mainExe: inspected.main.exe,
    targets: inspected.targets.length,
  })
  mark('verified-marker')

  const gate = await waitForGo(handoffDir, hostPid)
  if (gate.status === 'aborted') {
    mark('aborted', gate.value?.reason ?? null)
    await writeResult(handoffDir, { ...base, status: 'aborted', reason: String(gate.value?.reason ?? 'aborted before go') })
    printAndExit(0)
    return
  }
  if (gate.status === 'host-gone') {
    mark('host-gone')
    await writeResult(handoffDir, { ...base, status: 'failed', reason: 'Host exited before writing go; no process was touched' })
    printAndExit(0)
    return
  }
  if (gate.status === 'timeout') {
    mark('go-timeout')
    await writeResult(handoffDir, { ...base, status: 'failed', reason: 'Host did not write go in time; no process was touched' })
    printAndExit(0)
    return
  }
  mark('go')

  const current = await inspectHost(hostPid)
  if (!current.ok) {
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason: current.reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason: current.reason })
    printAndExit(0)
    return
  }
  if (!sameIdentity(current.host, { pid: hostPid, creationTime: request.hostCreationTime, exe: request.hostExe }) ||
      !sameIdentity(current.main, expectedMain)) {
    const reason = 'target identity changed immediately before freeze'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason })
    printAndExit(0)
    return
  }
  mark('re-inspect')

  const before = await readMemory()
  const freeze = await runJson(freezeScript, [
    '-ProcessId',
    String(current.main.pid),
    '-CreationTime',
    String(current.main.creationTime),
    '-Exe',
    current.main.exe,
  ])
  if (!freeze.ok || freeze.value?.ok !== true) {
    const reason = `failed to freeze the Electron main process: ${freeze.error ?? freeze.value?.error ?? 'unknown error'}`
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason, memoryBefore: before })
    printAndExit(0)
    return
  }
  mark('frozen')
  await writeMarker(handoffDir, 'frozen.json', { ok: true, at: Date.now(), helperPid, mainPid: current.main.pid })

  await writeJsonAtomic(join(handoffDir, 'progress.json'), { phase: 'frozen', at: Date.now() }).catch(() => {})

  let hostExited = await waitHostExit(hostPid, HOST_EXIT_WAIT_MS)
  if (!hostExited) {
    mark('host-exit-timeout')
    const hostTarget = { pid: current.host.pid, creationTime: current.host.creationTime, exe: current.host.exe }
    const escalated = await terminateTargets(handoffDir, [hostTarget])
    mark('host-escalated', escalated.value ? { ok: escalated.value.ok } : { error: escalated.error })
    hostExited = await waitHostExit(hostPid, TARGET_EXIT_WAIT_MS)
  }
  if (!hostExited) {
    const reason = 'the Host process did not exit after graceful shutdown and escalation'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason, memoryBefore: before })
    printAndExit(0)
    return
  }
  mark('host-exited')

  const targets = [
    { pid: current.main.pid, creationTime: current.main.creationTime, exe: current.main.exe },
    ...current.targets.map(({ pid, creationTime, exe }) => ({ pid, creationTime, exe })),
  ]
  const terminated = await terminateTargets(handoffDir, targets)
  mark('terminated', terminated.value ? { ok: terminated.value.ok } : { error: terminated.error })

  const mainGone = await waitMainExit(current.main.pid, TARGET_EXIT_WAIT_MS)
  if (!mainGone) {
    const reason = 'the old Electron main process is still running; refusing to start a second instance'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason, memoryBefore: before })
    printAndExit(0)
    return
  }
  mark('old-instance-gone')

  const portReleased = await waitPortReleased(request.port, PORT_RELEASE_WAIT_MS)
  mark('port-check', portReleased)
  if (!portReleased.ok) {
    const reason = `the previous listener did not release port ${request.port}; refusing to relaunch`
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason, memoryBefore: before })
    printAndExit(0)
    return
  }

  const recovery = await waitMemoryRecovery(MEMORY_RECOVERY_WAIT_MS)
  mark('memory-recovery', recovery.ok ? { pct: recovery.sample?.pct ?? null } : { timeout: true })

  const launched = await relaunch({ ...request, mainExe: current.main.exe, mainArgv: current.main.argv }, self.escape, handoffDir)
  if (!launched.ok) {
    const reason = `failed to relaunch DSH Desktop: ${launched.error}`
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, { ...base, status: 'failed', reason, memoryBefore: before, memoryAfter: recovery.sample })
    printAndExit(0)
    return
  }
  const newPid = launched.pid ?? null
  mark('relaunched', { pid: newPid, escape: self.escape, escaped: launched.escaped ?? null })

  await sleep(3000)
  const alive = isAlive(newPid)
  const listening = alive ? await waitPortListening(request.port, 15000) : false
  const after = await readMemory()
  if (!alive) {
    const reason = 'the relaunched DSH Desktop process exited immediately'
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, {
      ...base,
      status: 'failed',
      reason,
      newPid,
      memoryBefore: before,
      memoryAfter: after,
      portListening: listening,
    })
    printAndExit(0)
    return
  }
  if (listening === false) {
    const reason = `the relaunched DSH Desktop did not listen on port ${request.port} in time`
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason })
    await writeResult(handoffDir, {
      ...base,
      status: 'failed',
      reason,
      newPid,
      memoryBefore: before,
      memoryAfter: after,
      portListening: listening,
    })
    printAndExit(0)
    return
  }
  mark('verified-new-instance', { listening })
  await writeResult(handoffDir, {
    ...base,
    status: 'succeeded',
    newPid,
    memoryBefore: before,
    memoryAfter: after,
    portListening: listening,
  })
  printAndExit(0)
}

main().catch(async (error) => {
  const reason = safeErrorMessage(error)
  mark('crashed', reason)
  if (process.argv[2] === '--capability' && typeof process.argv[3] === 'string') {
    await writeJsonAtomic(process.argv[3], {
      ok: false,
      checkedAt: Date.now(),
      pid: helperPid,
      reason,
    }).catch(() => {})
  }
  const handoffDir = process.argv[2]
  if (typeof handoffDir === 'string' && handoffDir.length > 0 && process.argv[2] !== '--capability') {
    await writeMarker(handoffDir, 'failed.json', { ok: false, at: Date.now(), reason }).catch(() => {})
    await writeResult(handoffDir, { status: 'failed', reason, error: reason }).catch(() => {})
  }
  printAndExit(1)
})
