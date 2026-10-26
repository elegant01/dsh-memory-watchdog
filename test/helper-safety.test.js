import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { powerShellAvailable } from '../lib/ps.js'
import { makeTempDir } from './helpers.js'

const helperPath = fileURLToPath(new URL('../lib/resources/helper.mjs', import.meta.url))
const available = process.platform === 'win32' && powerShellAvailable()

function runHelper(args, cwd, timeoutMs = 40000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ timedOut: true, code: null, stdout, stderr })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ timedOut: false, code: null, error, stdout, stderr })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ timedOut: false, code, stdout, stderr })
    })
  })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('the helper capability check fails closed outside a DSH Desktop tree', { skip: !available }, async () => {
  const temp = await makeTempDir()
  const capabilityPath = join(temp.dir, 'capability.json')
  const result = await runHelper(['--capability', capabilityPath], temp.dir)
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 0, result.stderr)

  const capability = await readJson(capabilityPath)
  assert.equal(capability.ok, false)
  assert.equal(typeof capability.reason, 'string')
  assert.ok(capability.reason.length > 0)
  assert.equal(capability.checkedAt > 0, true)
  await temp.cleanup()
})

test('a fabricated handoff request is rejected before any process is touched', { skip: !available }, async () => {
  const temp = await makeTempDir()
  const handoffDir = join(temp.dir, 'guard', 'handoff', 'fabricated')
  await mkdir(handoffDir, { recursive: true })
  await writeFile(
    join(handoffDir, 'request.json'),
    JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      pluginVersion: '0.1.0',
      hostPid: process.pid,
      hostCreationTime: 1,
      hostExe: process.execPath,
      mainPid: process.pid,
      mainCreationTime: 1,
      mainExe: process.execPath,
      mainArgv: [process.execPath, '--fake'],
      mainCwd: temp.dir,
      port: null,
      targets: [],
      trigger: null,
    }),
  )

  const result = await runHelper([handoffDir], temp.dir)
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 0, result.stderr)

  const failed = await readJson(join(handoffDir, 'failed.json'))
  assert.equal(failed.ok, false)
  assert.equal(typeof failed.reason, 'string')

  const report = await readJson(join(handoffDir, 'result.json'))
  assert.equal(report.status, 'failed')
  assert.equal(typeof report.reason, 'string')
  const phases = report.steps.map((step) => step.phase)
  assert.ok(phases.includes('start'))
  for (const phase of ['frozen', 'terminated', 'old-instance-gone', 'relaunched']) {
    assert.equal(phases.includes(phase), false, `${phase} must never be reached`)
  }

  for (const name of ['verified.json', 'go.json', 'frozen.json', 'targets.json']) {
    await assert.rejects(readFile(join(handoffDir, name), 'utf8'), { code: 'ENOENT' }, `${name} must not exist`)
  }
  await temp.cleanup()
})
