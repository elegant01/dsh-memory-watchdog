import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { POWERSHELL_TIMEOUT_MS } from './constants.js'
import { capText, safeErrorMessage } from './util.js'

export function powerShellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function powerShellAvailable(env = process.env) {
  return existsSync(powerShellPath(env))
}

export function runPowerShellJson({
  script,
  args = [],
  timeoutMs = POWERSHELL_TIMEOUT_MS,
  maxOutputBytes = 262144,
  env = process.env,
  spawnProcess = spawn,
  cwd,
}) {
  return new Promise((resolve) => {
    if (!existsSync(script)) {
      resolve({ ok: false, error: `script not found: ${script}` })
      return
    }
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let settled = false
    let child
    try {
      child = spawnProcess(
        powerShellPath(env),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          ...args,
        ],
        {
          windowsHide: true,
          shell: false,
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      resolve({ ok: false, error: safeErrorMessage(error) })
      return
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, ms: Date.now() - startedAt, stderr: capText(stderr, 2000) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({ ok: false, error: `PowerShell timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes > maxOutputBytes) {
        try {
          child.kill()
        } catch {}
        finish({ ok: false, error: 'PowerShell output exceeded the size limit' })
        return
      }
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk
    })
    child.once('error', (error) => finish({ ok: false, error: safeErrorMessage(error) }))
    child.once('close', (code) => {
      if (settled) return
      const text = stdout.trim()
      if (text.length === 0) {
        finish({ ok: false, error: `PowerShell exited with ${String(code)} and produced no output` })
        return
      }
      let value
      try {
        value = JSON.parse(text)
      } catch {
        finish({ ok: false, error: 'PowerShell output was not valid JSON', output: capText(text, 500) })
        return
      }
      finish({ ok: true, value })
    })
  })
}
