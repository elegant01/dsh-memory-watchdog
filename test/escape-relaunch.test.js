import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { powerShellAvailable, runPowerShellJson } from '../lib/ps.js'
import { makeTempDir } from './helpers.js'

const available = process.platform === 'win32' && powerShellAvailable()
const resources = (name) => fileURLToPath(new URL(`../lib/resources/${name}`, import.meta.url))

test('escape.ps1 reports the job escape result as readable JSON', { skip: !available }, async () => {
  const result = await runPowerShellJson({ script: resources('escape.ps1'), args: [], timeoutMs: 30000 })
  assert.equal(result.ok, true, result.error + ' ' + (result.stderr ?? ''))
  const value = result.value
  assert.equal(value.ok, true)
  assert.equal(typeof value.selfInJob, 'boolean')
  assert.equal(value.plainError, null, 'the no-op probe child must start')
  assert.equal(typeof value.plainInJob, 'boolean')
  assert.equal(typeof value.breakawayOk, 'boolean')
  if (value.breakawayOk) assert.equal(typeof value.breakawayInJob, 'boolean')
  else assert.equal(typeof value.breakawayError, 'number')
  if (!value.selfInJob) {
    assert.equal(value.plainInJob, false)
    assert.equal(value.breakawayOk, true)
    assert.equal(value.breakawayInJob, false)
  }
})

test('relaunch.ps1 starts the requested exe with the given argv and env block', { skip: !available }, async () => {
  const temp = await makeTempDir()
  const outFile = join(temp.dir, 'child-env.txt')
  const request = join(temp.dir, 'relaunch-request.json')
  await writeFile(
    request,
    JSON.stringify({
      exe: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'set', '>', outFile],
      cwd: temp.dir,
      env: ['MGPROBE=escaped value', 'PATH=C:\\Windows\\System32'],
    }),
    'utf8'
  )

  const result = await runPowerShellJson({ script: resources('relaunch.ps1'), args: ['-RequestFile', request], timeoutMs: 30000 })
  assert.equal(result.ok, true, result.error + ' ' + (result.stderr ?? ''))
  assert.equal(result.value.ok, true, result.value.error)
  assert.equal(Number.isInteger(result.value.pid), true)
  assert.equal(typeof result.value.inJob, 'boolean')

  const deadline = Date.now() + 10000
  let dumped = ''
  while (Date.now() < deadline) {
    dumped = await readFile(outFile, 'utf8').catch(() => '')
    if (dumped.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.match(dumped, /MGPROBE=escaped value/)
  assert.doesNotMatch(dumped, /ELECTRON_RUN_AS_NODE/)
  await temp.cleanup()
})

test('relaunch.ps1 fails without touching anything when the exe is missing', { skip: !available }, async () => {
  const temp = await makeTempDir()
  const request = join(temp.dir, 'bad-request.json')
  await writeFile(request, JSON.stringify({ exe: join(temp.dir, 'definitely-missing.exe'), args: [], cwd: temp.dir, env: ['PATH=C:\\Windows\\System32'] }), 'utf8')
  const result = await runPowerShellJson({ script: resources('relaunch.ps1'), args: ['-RequestFile', request], timeoutMs: 30000 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.pid, null)
  assert.match(String(result.value.error), /error \d+/)
  await temp.cleanup()
})
