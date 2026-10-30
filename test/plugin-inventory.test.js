import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPluginInventory, ownDirectory, profileDirectoryOf, scanInstalledPlugins, scriptPath } from '../lib/plugin-inventory.js'
import { attributeStack } from '../lib/plugin-radar.js'
import { makeTempDir } from './helpers.js'

function stackOf(...frames) {
  return ['Error: probe', ...frames.map((frame) => '    at ' + frame)].join('\n')
}

test('scriptPath normalizes file URLs, Windows paths and non-file frames', () => {
  assert.equal(scriptPath('file:///F:/x/node_modules/a/lib/index.js'), 'f:/x/node_modules/a/lib/index.js')
  assert.equal(scriptPath('file:///F:/x/a%20b/index.js'), 'f:/x/a b/index.js')
  assert.equal(scriptPath('file:///home/u/a.js'), '/home/u/a.js')
  assert.equal(scriptPath('C:\\x\\y\\z.js'), 'c:/x/y/z.js')
  assert.equal(scriptPath('node:internal/timers'), null)
  assert.equal(scriptPath('(native)'), null)
  assert.equal(scriptPath(''), null)
})

test('ownDirectory is null when the package runs from a source tree', () => {
  assert.equal(ownDirectory(), null)
})

test('profileDirectoryOf strips the trailing package path', () => {
  assert.equal(
    profileDirectoryOf('C:/u/.dsh/profiles/desktop/node_modules/dsh-ops'),
    'C:/u/.dsh/profiles/desktop'
  )
  assert.equal(profileDirectoryOf('C:/x/lib/index.js'), null)
})

test('scanInstalledPlugins picks up packages marked as dsh plugins', async () => {
  const temp = await makeTempDir()
  try {
    const modules = join(temp.dir, 'node_modules')
    const write = async (name, manifest) => {
      await mkdir(join(modules, name), { recursive: true })
      await writeFile(join(modules, name, 'package.json'), JSON.stringify(manifest))
    }
    await write('dsh-ops', { name: 'dsh-ops', version: '0.4.4', dsh: { client: {} } })
    await write('billion-context', { name: 'billion-context', version: '0.1.209', dsh: {} })
    await write('plain-lib', { name: 'plain-lib', version: '1.0.0' })
    await write('@scope/scoped-plugin', { name: '@scope/scoped-plugin', version: '2.0.0', dsh: {} })
    await write('dsh-memory-watchdog', { name: 'dsh-memory-watchdog', version: '9.9.9', dsh: {} })

    const plugins = await scanInstalledPlugins(temp.dir, { ownPackage: 'dsh-memory-watchdog' })
    assert.deepEqual(
      plugins.map((plugin) => plugin.key),
      ['@scope/scoped-plugin', 'billion-context', 'dsh-ops']
    )
    assert.equal(plugins.find((plugin) => plugin.key === 'dsh-ops').version, '0.4.4')
    assert.match(plugins.find((plugin) => plugin.key === 'dsh-ops').path, /node_modules\/dsh-ops\/$/)

    const missing = await scanInstalledPlugins(join(temp.dir, 'nope'))
    assert.deepEqual(missing, [])
  } finally {
    await temp.cleanup()
  }
})

test('attributeStack credits installed plugin directories and skips framework frames', () => {
  const ownerDirs = [
    { key: 'dsh-ops', name: 'dsh-ops', kind: 'plugin', path: 'c:/u/.dsh/profiles/desktop/node_modules/dsh-ops/' },
    { key: 'dsh-unlag', name: 'dsh-unlag', kind: 'plugin', path: 'c:/u/.dsh/profiles/desktop/node_modules/dsh-unlag/' },
  ]
  const options = { ownPackage: 'dsh-memory-watchdog', ownDir: 'C:/u/.dsh/profiles/desktop/node_modules/dsh-memory-watchdog', ownerDirs }

  const direct = attributeStack(
    stackOf(
      'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-memory-watchdog/lib/plugin-radar.js:186:20',
      'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/index.js:41:5',
      'node:internal/modules/esm/module_job:1:1'
    ),
    options
  )
  assert.equal(direct.matched, 'directory')
  assert.equal(direct.owner.key, 'dsh-ops')

  const throughFramework = attributeStack(
    stackOf(
      'file:///E:/App/resources/app.asar/dsh/dsh-app-boot/lib/index.js:10:3',
      'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-unlag/lib/index.js:7:9'
    ),
    options
  )
  assert.equal(throughFramework.owner.key, 'dsh-unlag')

  const builtinOnly = attributeStack(stackOf('at node:internal/timers:1:1'), options)
  assert.equal(builtinOnly.owner, null)
  assert.equal(builtinOnly.matched, 'none')

  const localOnly = attributeStack(stackOf('file:///F:/scratch/script.js:1:1'), options)
  assert.equal(localOnly.owner, null)
  assert.equal(localOnly.sample, 'f:/scratch/script.js')
})

test('loadPluginInventory reports an empty inventory from a source tree', async () => {
  const inventory = await loadPluginInventory({ ownPackage: 'dsh-memory-watchdog' })
  assert.equal(inventory.ownDir, null)
  assert.equal(inventory.profileDir, null)
  assert.deepEqual(inventory.plugins, [])
  assert.deepEqual(inventory.dirs, [])
})