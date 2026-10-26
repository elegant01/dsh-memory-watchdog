import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  COLLECTOR_BACKOFF_MS,
  COLLECTOR_MALFORMED_RESTART_AFTER,
  SAMPLE_INTERVAL_MS,
} from './constants.js'
import { BoundedLineReader, parseCollectorSample } from './jsonl.js'
import { powerShellAvailable, powerShellPath } from './ps.js'
import { capText, safeErrorMessage, sleep } from './util.js'

export class CollectorSupervisor {
  constructor({
    scriptPath,
    intervalMs = SAMPLE_INTERVAL_MS,
    now = Date.now,
    env = process.env,
    spawnProcess = spawn,
    onSample,
    onError,
    onRecovered,
    onStateChange,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    stopTimeoutMs = 3000,
  }) {
    this.scriptPath = scriptPath
    this.intervalMs = intervalMs
    this.now = now
    this.env = env
    this.spawnProcess = spawnProcess
    this.onSample = onSample
    this.onError = onError
    this.onRecovered = onRecovered
    this.onStateChange = onStateChange
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.stopTimeoutMs = stopTimeoutMs
    this.stopping = false
    this.child = null
    this.reader = null
    this.restartTimer = null
    this.restartAt = null
    this.backoffIndex = 0
    this.restarts = 0
    this.startedAt = 0
    this.lastSampleAt = 0
    this.lastError = null
    this.lastExit = null
    this.malformedCount = 0
    this.hadError = false
  }

  start() {
    if (this.child !== null || this.stopping) return
    if (!existsSync(this.scriptPath)) {
      this.reportError('missing-script', `collector script not found: ${this.scriptPath}`)
      return
    }
    if (!powerShellAvailable(this.env)) {
      this.reportError('missing-powershell', `PowerShell not found at ${powerShellPath(this.env)}`)
      return
    }
    let child
    try {
      child = this.spawnProcess(
        powerShellPath(this.env),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
          '-IntervalMs',
          String(this.intervalMs),
        ],
        {
          windowsHide: true,
          shell: false,
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      this.reportError('spawn-failed', safeErrorMessage(error))
      this.scheduleRestart()
      return
    }
    this.child = child
    this.startedAt = this.now()
    const reader = new BoundedLineReader({
      onLine: (line) => this.handleLine(line),
      onError: (kind) => this.handleMalformed(kind),
    })
    this.reader = reader
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => reader.push(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const text = capText(chunk, 2000).trim()
      if (text.length > 0) this.reportError('stderr', text)
    })
    child.once('error', (error) => {
      if (this.child === child) {
        this.child = null
        this.reader = null
        this.lastExit = { at: this.now(), code: null, signal: 'spawn-error' }
      }
      this.reportError('spawn-failed', safeErrorMessage(error))
      if (!this.stopping) this.scheduleRestart()
    })
    child.once('close', (code, signal) => {
      reader.end()
      if (this.child === child) this.child = null
      this.reader = null
      this.lastExit = { at: this.now(), code, signal }
      if (this.stopping) return
      this.reportError(
        'exited',
        `collector exited with ${code === null ? 'no code' : String(code)}${signal ? ` (${signal})` : ''}`,
      )
      this.scheduleRestart()
    })
    this.emitState()
  }

  handleLine(line) {
    const parsed = parseCollectorSample(line, this.now())
    if (parsed.error) {
      if (parsed.error.startsWith('collector-error:')) {
        this.reportError('collector', parsed.error.slice('collector-error:'.length).trim())
      } else {
        this.handleMalformed(parsed.error)
      }
      return
    }
    const sample = parsed.sample
    this.malformedCount = 0
    this.lastSampleAt = this.now()
    if (this.hadError) {
      this.hadError = false
      this.onRecovered?.({ at: this.lastSampleAt })
    }
    if (this.restarts > 0 && this.lastSampleAt - this.startedAt > 60000) {
      this.backoffIndex = 0
    }
    this.onSample?.(sample)
    this.emitState()
  }

  handleMalformed(kind) {
    this.malformedCount += 1
    this.reportError('malformed', `collector output: ${kind}`)
    if (this.malformedCount >= COLLECTOR_MALFORMED_RESTART_AFTER && this.child !== null) {
      this.malformedCount = 0
      const child = this.child
      this.child = null
      try {
        child.kill()
      } catch {}
      this.scheduleRestart()
    }
  }

  reportError(kind, message) {
    this.lastError = { at: this.now(), kind, message }
    this.hadError = true
    this.onError?.(this.lastError)
    this.emitState()
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer !== null) return
    const delay = COLLECTOR_BACKOFF_MS[Math.min(this.backoffIndex, COLLECTOR_BACKOFF_MS.length - 1)]
    this.backoffIndex += 1
    this.restarts += 1
    this.restartAt = this.now() + delay
    this.restartTimer = this.setTimeoutFn(() => {
      this.restartTimer = null
      this.restartAt = null
      if (!this.stopping) this.start()
    }, delay)
    this.restartTimer.unref?.()
    this.emitState()
  }

  emitState() {
    this.onStateChange?.(this.state())
  }

  state() {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastSampleAt: this.lastSampleAt || null,
      lastError: this.lastError,
      lastExit: this.lastExit,
      nextRestartInMs: this.restartAt === null ? null : Math.max(0, this.restartAt - this.now()),
      backoffIndex: this.backoffIndex,
    }
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer !== null) {
      this.clearTimeoutFn(this.restartTimer)
      this.restartTimer = null
      this.restartAt = null
    }
    const child = this.child
    this.child = null
    this.reader = null
    if (child === null) return
    const exited = new Promise((resolve) => {
      child.once('close', resolve)
      child.once('error', resolve)
    })
    try {
      child.kill()
    } catch {}
    await Promise.race([exited, sleep(this.stopTimeoutMs)])
  }
}
