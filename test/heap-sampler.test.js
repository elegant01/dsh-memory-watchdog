import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateProfile, memorySnapshot, packageFromUrl, siteFile } from '../lib/heap-sampler.js'

function frame(functionName, url, selfSize, children = []) {
  return { callFrame: { functionName, url, lineNumber: 1, columnNumber: 1 }, selfSize, children }
}

test('packageFromUrl recognises npm, scoped, asar, snapshot and builtin frames', () => {
  const npm = packageFromUrl('file:///C:/Users/me/.dsh/profiles/desktop/node_modules/dsh-ops/lib/index.js')
  assert.equal(npm.key, 'dsh-ops')
  assert.equal(npm.kind, 'npm')

  const scoped = packageFromUrl('file:///C:/Users/me/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-goal/lib/index.js')
  assert.equal(scoped.key, '@deepseek-ai/dsh-goal')

  const asar = packageFromUrl('file:///E:/DeepSeek%20Harness/resources/app.asar/dsh/dsh-agent/lib/x.js')
  assert.equal(asar.key, 'dsh-agent')
  assert.equal(asar.kind, 'asar')

  const snapshot = packageFromUrl('file:///F:/centos/dsh-memory-guard/.dsh-src/dsh-goal/lib/index.js')
  assert.equal(snapshot.key, 'dsh-goal')
  assert.equal(snapshot.kind, 'source')

  const builtin = packageFromUrl('node:internal/timers')
  assert.equal(builtin.key, '(builtin)')
  assert.equal(packageFromUrl('evalsomething'), null)
  assert.equal(packageFromUrl(''), null)
})

test('aggregateProfile attributes anonymous children to the nearest JS frame', () => {
  const profile = {
    head: frame('(root)', '', 0, [
      frame('grow', 'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/a.js', 100, [
        frame('(native)', '', 300),
      ]),
      frame('tick', 'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-unlag/lib/b.js', 50),
      frame('localFn', 'file:///F:/repo/scratch.mjs', 7),
    ]),
  }
  const result = aggregateProfile(profile)
  assert.equal(result.totalBytes, 457)
  const byKey = Object.fromEntries(result.packages.map((entry) => [entry.key, entry.bytes]))
  assert.equal(byKey['dsh-ops'], 400)
  assert.equal(byKey['dsh-unlag'], 50)
  assert.equal(byKey['(local)'], 7)
  assert.equal(result.nativeBytes, 0)
  assert.equal(result.attributedBytes, 457)
})

test('aggregateProfile keeps root-level anonymous bytes as native', () => {
  const profile = { head: frame('(root)', '', 0, [frame('', '', 128)]) }
  const result = aggregateProfile(profile)
  assert.equal(result.totalBytes, 128)
  assert.equal(result.nativeBytes, 128)
  assert.deepEqual(result.packages, [])
})

test('aggregateProfile tolerates junk input', () => {
  assert.deepEqual(aggregateProfile(null), { totalBytes: 0, attributedBytes: 0, nativeBytes: 0, packages: [] })
  assert.deepEqual(aggregateProfile({}), { totalBytes: 0, attributedBytes: 0, nativeBytes: 0, packages: [] })
})

test('memorySnapshot reports process numbers', () => {
  const usage = memorySnapshot()
  assert.ok(usage.rss > 0)
  assert.ok(usage.heapUsed > 0)
  assert.equal(typeof usage.external, 'number')
})

test('siteFile shortens allocation urls to a readable site', () => {
  assert.equal(
    siteFile('file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/index.js'),
    'lib/index.js',
  )
  assert.equal(
    siteFile('file:///C:/u/.dsh/profiles/desktop/node_modules/@scope/plug/lib/deep/x.js'),
    'lib/deep/x.js',
  )
  assert.equal(siteFile('file:///E:/DeepSeek%20Harness/resources/app.asar/dsh/dsh-agent/lib/x.js'), 'lib/x.js')
  assert.equal(siteFile('file:///F:/repo/scratch.mjs'), 'scratch.mjs')
  assert.equal(siteFile('node:internal/timers'), null)
  assert.equal(siteFile(''), null)
  assert.equal(siteFile(undefined), null)
})

test('aggregateProfile merges repeated sites and keeps the top ones', () => {
  const url = 'file:///C:/u/.dsh/profiles/desktop/node_modules/dsh-ops/lib/heap.js'
  const profile = {
    head: frame('(root)', '', 0, [
      frame('grow', url, 100, [frame('grow', url, 300)]),
      frame('other', url, 50),
    ]),
  }
  const result = aggregateProfile(profile)
  const ops = result.packages.find((entry) => entry.key === 'dsh-ops')
  assert.equal(ops.bytes, 450)
  assert.deepEqual(ops.top[0], { functionName: 'grow', file: 'lib/heap.js', line: 1, bytes: 400 })
  assert.equal(ops.top[1].functionName, 'other')
  assert.equal(ops.top[1].file, 'lib/heap.js')
})