import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { applyHmr } from '../scripts/hmr.mjs'
import { deploy, PACKAGE_NAME, LEGACY_PACKAGE_NAME } from '../scripts/deploy.mjs'
import { makeTempDir } from './helpers.js'

const PATCH = [
  '# profile patch',
  '- id: ui-chat',
  "  name: \"@deepseek-ai/dsh-client-ui-chat\"",
  '  config:',
  '    transcriptView: standard',
  '- id: hmr',
  "  name: '@deepseek-ai/dsh-hmr'",
  '  disabled: false',
  '  config:',
  '    root:',
  '      - node_modules/dsh-codearts',
  '    ignored:',
  '      - "**/node_modules/**"',
  '',
].join('\n')

async function makeProfile() {
  const temp = await makeTempDir('dsh-memory-watchdog-profile-')
  const modules = join(temp.dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  await writeFile(join(temp.dir, 'cordis.patch.yml'), PATCH, 'utf8')
  await writeFile(
    join(temp.dir, 'package.json'),
    JSON.stringify(
      {
        name: 'profile',
        dependencies: { 'dsh-codearts': '1.1.3', [LEGACY_PACKAGE_NAME]: '0.1.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-codearts', LEGACY_PACKAGE_NAME] } },
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({ hoistedLocations: {} }, null, 2) + '\n', 'utf8')
  await mkdir(join(modules, LEGACY_PACKAGE_NAME), { recursive: true })
  await writeFile(join(modules, LEGACY_PACKAGE_NAME, 'package.json'), '{"name":"dsh-memory-guard"}\n', 'utf8')
  return {
    dir: temp.dir,
    cleanup: temp.cleanup,
    patch: () => readFile(join(temp.dir, 'cordis.patch.yml'), 'utf8'),
    manifest: async () => JSON.parse(await readFile(join(temp.dir, 'package.json'), 'utf8')),
  }
}

function backupsIn(dir) {
  const out = []
  for (const entry of readdirSync(dir)) if (entry.includes('.bak-')) out.push(entry)
  return out
}

test('hmr status reports the current watch list without writing', async () => {
  const profile = await makeProfile()
  const before = await profile.patch()
  const status = applyHmr({ profileDir: profile.dir, action: 'status' })
  assert.equal(status.state, 'not watching us')
  assert.deepEqual(status.roots, ['node_modules/dsh-codearts'])
  assert.equal(await profile.patch(), before)
  await rm(join(profile.dir, 'cordis.patch.yml'), { force: true })
  assert.throws(() => applyHmr({ profileDir: profile.dir, action: 'status' }), /cordis\.patch\.yml/)
  await profile.cleanup()
})

test('hmr on keeps the other plugin root, empties ignored and stays idempotent', async () => {
  const profile = await makeProfile()
  const first = applyHmr({ profileDir: profile.dir, action: 'on' })
  assert.equal(first.changed, true)
  assert.ok(first.backup && existsSync(first.backup), 'the patch must be backed up before rewriting')

  const text = await profile.patch()
  assert.match(text, /- node_modules\/dsh-codearts/)
  assert.match(text, new RegExp(`- node_modules/${PACKAGE_NAME}`))
  assert.match(text, /ignored: \[\]/)
  assert.ok(!Buffer.from(text).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'no BOM')
  assert.equal(backupsIn(profile.dir).length, 1)

  const again = applyHmr({ profileDir: profile.dir, action: 'on' })
  assert.equal(again.changed, false)
  assert.equal(await profile.patch(), text)
  await profile.cleanup()
})

test('hmr off drops only our root and keeps the other plugin watched', async () => {
  const profile = await makeProfile()
  applyHmr({ profileDir: profile.dir, action: 'on' })
  applyHmr({ profileDir: profile.dir, action: 'off' })
  const text = await profile.patch()
  assert.match(text, /- node_modules\/dsh-codearts/)
  assert.doesNotMatch(text, new RegExp(`node_modules/${PACKAGE_NAME}`))

  const clean = await makeProfile()
  applyHmr({ profileDir: clean.dir, action: 'off' })
  const withoutOurs = await clean.patch()
  assert.match(withoutOurs, /- node_modules\/dsh-codearts/)
  assert.equal(applyHmr({ profileDir: clean.dir, action: 'status' }).state, 'not watching us')
  await clean.cleanup()
  await profile.cleanup()
})

test('deploy syncs the package in place and pins the exact version', async () => {
  const profile = await makeProfile()
  const result = deploy({ profileDir: profile.dir, quiet: true })
  const packageDir = join(profile.dir, 'node_modules', PACKAGE_NAME)
  assert.equal(result.packageDir, packageDir)
  assert.ok(existsSync(join(packageDir, 'lib', 'index.js')))
  assert.ok(existsSync(join(packageDir, 'lib', 'client', 'index.js')))
  assert.ok(existsSync(join(packageDir, 'lib', 'resources', 'top.ps1')))
  assert.ok(existsSync(join(packageDir, 'cordis.patch.yml')))
  assert.ok(existsSync(join(packageDir, 'CHANGELOG.md')))

  const manifest = await profile.manifest()
  assert.equal(manifest.dependencies[PACKAGE_NAME], result.version)
  assert.ok(manifest.dsh.profile.bundles.includes(PACKAGE_NAME))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-codearts'))
  const modules = JSON.parse(await readFile(join(profile.dir, 'node_modules', '.modules.yaml'), 'utf8'))
  assert.deepEqual(modules.hoistedLocations[`${PACKAGE_NAME}@${result.version}`], [`node_modules\\${PACKAGE_NAME}`])

  const second = deploy({ profileDir: profile.dir, quiet: true })
  assert.equal(second.files.added, 0, 'a re-deploy must not re-add files')
  assert.equal(second.files.updated, 0, 'identical bytes keep their mtime so hmr stays quiet')
  assert.ok(second.files.unchanged > 10)
  await profile.cleanup()
})

test('deploy rewrites a changed file in place instead of churning the directory', async () => {
  const profile = await makeProfile()
  deploy({ profileDir: profile.dir, quiet: true })
  const target = join(profile.dir, 'node_modules', PACKAGE_NAME, 'lib', 'constants.js')
  const before = (await stat(target)).mtimeMs
  await writeFile(target, '// stale\n', 'utf8')
  const result = deploy({ profileDir: profile.dir, quiet: true })
  assert.equal(result.files.updated, 1)
  assert.equal(result.files.added, 0)
  assert.equal(result.files.pruned, 0)
  assert.notEqual((await stat(target)).mtimeMs, before)
  assert.match(await readFile(target, 'utf8'), /PLUGIN_NAME/)
  await profile.cleanup()
})

test('deploy prunes the legacy name only when asked', async () => {
  const profile = await makeProfile()
  deploy({ profileDir: profile.dir, quiet: true })
  assert.ok(existsSync(join(profile.dir, 'node_modules', LEGACY_PACKAGE_NAME)))

  deploy({ profileDir: profile.dir, quiet: true, pruneLegacy: true })
  assert.ok(!existsSync(join(profile.dir, 'node_modules', LEGACY_PACKAGE_NAME)))
  const manifest = await profile.manifest()
  assert.equal(manifest.dependencies[LEGACY_PACKAGE_NAME], undefined)
  assert.ok(manifest.dependencies[PACKAGE_NAME], 'the new package keeps its pin')
  assert.ok(!manifest.dsh.profile.bundles.includes(LEGACY_PACKAGE_NAME))
  assert.ok(manifest.dsh.profile.bundles.includes(PACKAGE_NAME))
  assert.ok(backupsIn(profile.dir).some((name) => name.includes('package.json')))
  await profile.cleanup()
})

test('every deployed text file stays BOM-free', async () => {
  const profile = await makeProfile()
  deploy({ profileDir: profile.dir, quiet: true })
  const names = await readdir(join(profile.dir, 'node_modules', PACKAGE_NAME))
  assert.ok(names.includes('package.json'))
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const bytes = Buffer.from(await readFile(join(profile.dir, 'node_modules', PACKAGE_NAME, name)))
    assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${name} carries a BOM`)
  }
  const patch = Buffer.from(await profile.patch())
  assert.ok(!(patch[0] === 0xef && patch[1] === 0xbb && patch[2] === 0xbf))
  await rm(join(profile.dir, 'cordis.patch.yml'), { force: true })
  assert.throws(() => applyHmr({ profileDir: profile.dir, action: 'on' }), /cordis\.patch\.yml/)
  await profile.cleanup()
})
