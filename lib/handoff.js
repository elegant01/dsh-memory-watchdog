import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm as rmDirectory } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HANDOFF_FROZEN_TIMEOUT_MS,
  HANDOFF_VERIFY_TIMEOUT_MS,
  PLUGIN_VERSION,
} from './constants.js'
import { readJsonFile, safeErrorMessage, sleep, writeJsonAtomic } from './util.js'

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function validTarget(target) {
  return (
    target !== null &&
    typeof target === 'object' &&
    Number.isInteger(target.pid) &&
    target.pid > 0 &&
    Number.isFinite(target.creationTime) &&
    target.creationTime > 0 &&
    isNonEmptyString(target.exe)
  )
}

export function validateInspect(value, { hostPid }) {
  if (value === null || typeof value !== 'object' || value.ok !== true) {
    return { ok: false, reason: `inspect failed: ${value?.error ?? 'unknown error'}` }
  }
  const host = value.host
  const main = value.main
  if (host === null || typeof host !== 'object' || host.pid !== hostPid) {
    return { ok: false, reason: 'inspect: Host identity mismatch' }
  }
  if (!Number.isFinite(host.creationTime) || host.creationTime <= 0 || !isNonEmptyString(host.exe)) {
    return { ok: false, reason: 'inspect: Host identity is incomplete' }
  }
  if (main === null || typeof main !== 'object' || !Number.isInteger(main.pid) || main.pid <= 0) {
    return { ok: false, reason: 'inspect: Electron main process was not resolved' }
  }
  if (!Number.isFinite(main.creationTime) || main.creationTime <= 0 || !isNonEmptyString(main.exe)) {
    return { ok: false, reason: 'inspect: Electron main identity is incomplete' }
  }
  if (!Array.isArray(main.argv) || main.argv.length === 0) {
    return { ok: false, reason: 'inspect: Electron main command line was not readable' }
  }
  if (value.mainIsParent !== true) return { ok: false, reason: 'inspect: Host is not a child of the Electron main process' }
  if (value.sameExe !== true) return { ok: false, reason: 'inspect: Host and Electron main executables differ' }
  if (value.hostLooksDesktop !== true) return { ok: false, reason: 'inspect: Host process does not look like DSH Desktop Host' }
  if (value.mainLooksDesktop !== true) return { ok: false, reason: 'inspect: target process does not look like the Electron main process' }
  if (value.probeAccess?.main !== true) return { ok: false, reason: 'inspect: cannot open the Electron main process' }
  if (value.probeAccess?.host !== true) return { ok: false, reason: 'inspect: cannot open the Host process' }
  if (!Array.isArray(value.sameExeDescendants)) return { ok: false, reason: 'inspect: descendant list is missing' }
  for (const target of value.sameExeDescendants) {
    if (!validTarget(target)) return { ok: false, reason: 'inspect: descendant record is malformed' }
  }
  return { ok: true, host, main, targets: value.sameExeDescendants }
}

function buildRequest({ host, main, targets, port, now, version, trigger }) {
  const byPid = new Map()
  for (const target of [
    { pid: main.pid, creationTime: main.creationTime, exe: main.exe },
    { pid: host.pid, creationTime: host.creationTime, exe: host.exe },
    ...targets,
  ]) {
    if (!validTarget(target)) continue
    byPid.set(target.pid, target)
  }
  return {
    version: 1,
    createdAt: now,
    pluginVersion: version,
    hostPid: host.pid,
    hostCreationTime: host.creationTime,
    hostExe: host.exe,
    mainPid: main.pid,
    mainCreationTime: main.creationTime,
    mainExe: main.exe,
    mainArgv: main.argv.slice(),
    mainCwd: isNonEmptyString(main.cwd) ? main.cwd : null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    targets: [...byPid.values()],
    trigger: trigger ?? null,
  }
}

export class HandoffManager {
  constructor({
    guardDir,
    helperPath,
    inspectScript,
    runJson,
    spawnProcess = spawn,
    now = Date.now,
    version = PLUGIN_VERSION,
    env = process.env,
    hostPid = process.pid,
    portProvider = () => null,
    verifyTimeoutMs = HANDOFF_VERIFY_TIMEOUT_MS,
    frozenTimeoutMs = HANDOFF_FROZEN_TIMEOUT_MS,
  }) {
    this.guardDir = guardDir
    this.helperPath = helperPath
    this.inspectScript = inspectScript
    this.runJson = runJson
    this.spawnProcess = spawnProcess
    this.now = now
    this.version = version
    this.env = env
    this.hostPid = hostPid
    this.portProvider = portProvider
    this.verifyTimeoutMs = verifyTimeoutMs
    this.frozenTimeoutMs = frozenTimeoutMs
    this.child = null
    this.handoffDir = null
    this.request = null
  }

  async inspectHost() {
    const result = await this.runJson({
      script: this.inspectScript,
      args: ['-HostPid', String(this.hostPid), '-ProbeAccess'],
      cwd: this.guardDir,
    })
    if (!result.ok) return { ok: false, reason: result.error }
    return validateInspect(result.value, { hostPid: this.hostPid })
  }

  spawnHelper(args, { detached = true } = {}) {
    let child
    try {
      child = this.spawnProcess(process.execPath, [this.helperPath, ...args], {
        detached,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
        env: { ...this.env, ELECTRON_RUN_AS_NODE: '1' },
        cwd: this.guardDir,
      })
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error) }
    }
    child.unref?.()
    return { ok: true, child }
  }

  async checkCapability({ timeoutMs = 15000 } = {}) {
    const capabilityPath = join(this.guardDir, 'capability.json')
    await rmDirectory(capabilityPath, { force: true }).catch(() => {})
    const spawned = this.spawnHelper(['--capability', capabilityPath])
    if (!spawned.ok) return { ok: false, reason: spawned.error, checkedAt: this.now() }
    const waited = await this.waitForFile(capabilityPath, timeoutMs, null)
    if (!waited.ok) {
      this.killSpawned(spawned.child)
      return { ok: false, reason: waited.error, checkedAt: this.now() }
    }
    const value = waited.value
    if (value === null || typeof value !== 'object') {
      return { ok: false, reason: 'capability result was not an object', checkedAt: this.now() }
    }
    if (value.ok !== true) {
      return {
        ok: false,
        reason: typeof value.reason === 'string' ? value.reason : 'capability check failed',
        checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : this.now(),
        inJob: value.inJob === true,
      }
    }
    return {
      ok: true,
      reason: null,
      checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : this.now(),
      helperPid: value.pid ?? null,
      mainPid: value.mainPid ?? null,
      inJob: false,
    }
  }

  async prepare({ trigger = null } = {}) {
    await mkdir(this.guardDir, { recursive: true })
    const inspected = await this.inspectHost()
    if (!inspected.ok) return { ok: false, reason: inspected.reason }
    const id = `${this.now()}-${Math.random().toString(36).slice(2, 8)}`
    const handoffDir = join(this.guardDir, 'handoff', id)
    const root = join(this.guardDir, 'handoff')
    try {
      await mkdir(root, { recursive: true })
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== id) await rmDirectory(join(root, entry.name), { recursive: true, force: true })
      }
      await mkdir(handoffDir, { recursive: true })
    } catch (error) {
      return { ok: false, reason: `unable to prepare handoff directory: ${safeErrorMessage(error)}` }
    }
    const request = buildRequest({
      host: inspected.host,
      main: inspected.main,
      targets: inspected.targets,
      port: this.portProvider(),
      now: this.now(),
      version: this.version,
      trigger,
    })
    const requestPath = join(handoffDir, 'request.json')
    await writeJsonAtomic(requestPath, request)
    const spawned = this.spawnHelper([handoffDir])
    if (!spawned.ok) return { ok: false, reason: spawned.error, handoffDir }
    this.child = spawned.child
    this.handoffDir = handoffDir
    this.request = request
    return { ok: true, handoffDir, helperPid: spawned.child.pid ?? null, request }
  }

  async waitForVerified() {
    const result = await this.waitForAny(
      [join(this.handoffDir, 'verified.json'), join(this.handoffDir, 'failed.json')],
      this.verifyTimeoutMs,
    )
    if (!result.ok) return { status: 'timeout', error: result.error }
    if (result.name === 'failed.json') return { status: 'failed', value: result.value }
    if (result.value?.ok !== true) return { status: 'failed', value: result.value }
    return { status: 'verified', value: result.value }
  }

  async waitForFrozen() {
    const result = await this.waitForAny(
      [join(this.handoffDir, 'frozen.json'), join(this.handoffDir, 'failed.json')],
      this.frozenTimeoutMs,
    )
    if (!result.ok) return { status: 'timeout', error: result.error }
    if (result.name === 'failed.json') return { status: 'failed', value: result.value }
    if (result.value?.ok !== true) return { status: 'failed', value: result.value }
    return { status: 'frozen', value: result.value }
  }

  async writeGo() {
    await writeJsonAtomic(join(this.handoffDir, 'go.json'), { at: this.now() })
  }

  async abort(reason) {
    if (this.handoffDir === null) return
    await writeJsonAtomic(join(this.handoffDir, 'abort.json'), { at: this.now(), reason: String(reason) }).catch(() => {})
    await this.waitForChildExit(3000)
    this.killSpawned(this.child)
    this.child = null
  }

  async waitForChildExit(timeoutMs) {
    if (this.child === null || this.child.exitCode !== null) return true
    const child = this.child
    const exited = new Promise((resolve) => {
      child.once('close', resolve)
      child.once('error', resolve)
    })
    const winner = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)])
    return winner
  }

  killSpawned(child) {
    if (child === null || child === undefined) return
    if (child.exitCode !== null) return
    try {
      child.kill()
    } catch {}
  }

  async waitForAny(paths, timeoutMs, child = this.child) {
    const deadline = this.now() + timeoutMs
    for (;;) {
      for (const path of paths) {
        const result = await readJsonFile(path)
        if (result.ok) return { ok: true, name: path.split(/[\\/]/).pop(), value: result.value }
      }
      if (child !== null && child !== undefined && child.exitCode !== null) {
        return { ok: false, error: `helper exited before writing a marker (code ${String(child.exitCode)})` }
      }
      if (this.now() >= deadline) return { ok: false, error: `timed out after ${timeoutMs} ms` }
      await sleep(100)
    }
  }

  async waitForFile(path, timeoutMs, child = this.child) {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const result = await readJsonFile(path)
      if (result.ok) return { ok: true, value: result.value }
      if (child !== null && child !== undefined && child.exitCode !== null) {
        const retry = await readJsonFile(path)
        if (retry.ok) return { ok: true, value: retry.value }
        return { ok: false, error: `helper exited before writing ${path.split(/[\\/]/).pop()} (code ${String(child.exitCode)})` }
      }
      if (this.now() >= deadline) return { ok: false, error: `timed out after ${timeoutMs} ms` }
      await sleep(100)
    }
  }

  async readResult() {
    if (this.handoffDir === null) return null
    const result = await readFile(join(this.handoffDir, 'result.json'), 'utf8').catch(() => null)
    if (result === null) return null
    try {
      return JSON.parse(result)
    } catch {
      return null
    }
  }
}
