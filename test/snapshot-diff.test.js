import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffHeapSnapshots } from '../lib/snapshot-diff.js'
import { PluginMemory } from '../lib/plugin-memory.js'

const NODE_FIELDS = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
const NODE_TYPES = ['hidden', 'object', 'array', 'string', 'native']

function buildSnapshot({ entries = [], hidden = 0 } = {}) {
  const strings = ['']
  const indexByName = new Map()
  function intern(name) {
    if (!indexByName.has(name)) {
      indexByName.set(name, strings.length)
      strings.push(name)
    }
    return indexByName.get(name)
  }

  const nodes = [0, 0, 1, 0, 0, 0, 0]
  let id = 2
  for (let i = 0; i < hidden; i += 1) {
    nodes.push(0, intern(`hidden-${i}`), id, 4096, 0, 0, 0)
    id += 1
  }
  for (const entry of entries) {
    const name = intern(entry.name)
    for (let i = 0; i < entry.count; i += 1) {
      nodes.push(entry.typeIndex ?? 1, name, id, entry.size, 0, 0, 0)
      id += 1
    }
  }

  return {
    snapshot: {
      meta: {
        node_fields: NODE_FIELDS,
        node_types: [NODE_TYPES],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'hidden']],
      },
      node_count: nodes.length / NODE_FIELDS.length,
      edge_count: 0,
    },
    nodes,
    edges: [],
    strings,
  }
}

async function writeSnapshot(dir, name, body) {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(body))
  return path
}

test('the diff points in the right direction and counts the new objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-diff-'))
  try {
    const older = await writeSnapshot(dir, 'older.heapsnapshot', buildSnapshot({ entries: [{ name: 'Widget', count: 1000, size: 24 }] }))
    const newer = await writeSnapshot(dir, 'newer.heapsnapshot', buildSnapshot({ entries: [{ name: 'Widget', count: 2000, size: 24 }] }))
    const diff = await diffHeapSnapshots(older, newer)
    const widget = diff.top.find((row) => row.name === 'Widget')
    assert.ok(widget, 'Widget must be in the top rows')
    assert.equal(widget.olderBytes, 24000)
    assert.equal(widget.newerBytes, 48000)
    assert.equal(widget.deltaBytes, 24000)
    assert.equal(widget.olderCount, 1000)
    assert.equal(widget.newerCount, 2000)
    assert.ok(diff.deltaBytes > 0)
    assert.ok(diff.nodeDelta > 0)
    assert.equal(diff.older.name, 'older.heapsnapshot')
    assert.equal(diff.newer.name, 'newer.heapsnapshot')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('names that only exist on one side get a signed delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-diff-'))
  try {
    const older = await writeSnapshot(
      dir,
      'older.heapsnapshot',
      buildSnapshot({ entries: [{ name: 'Kept', count: 10, size: 16 }, { name: 'Gone', count: 50, size: 32 }] })
    )
    const newer = await writeSnapshot(
      dir,
      'newer.heapsnapshot',
      buildSnapshot({ entries: [{ name: 'Kept', count: 10, size: 16 }, { name: 'New', count: 70, size: 8 }] })
    )
    const diff = await diffHeapSnapshots(older, newer)
    const gone = diff.top.find((row) => row.name === 'Gone')
    const added = diff.top.find((row) => row.name === 'New')
    assert.equal(gone.deltaBytes, -1600)
    assert.equal(added.deltaBytes, 560)
    assert.equal(gone.newerBytes, 0)
    assert.equal(gone.newerCount, 0)
    assert.equal(added.olderBytes, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hidden nodes and internal names are left out of the aggregation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-diff-'))
  try {
    const older = await writeSnapshot(dir, 'older.heapsnapshot', buildSnapshot({ entries: [{ name: '(system)', count: 2, size: 1024 }] }))
    const newer = await writeSnapshot(
      dir,
      'newer.heapsnapshot',
      buildSnapshot({ hidden: 5, entries: [{ name: '(system)', count: 4, size: 1024 }, { name: 'Visible', count: 1, size: 64 }] })
    )
    const diff = await diffHeapSnapshots(older, newer)
    assert.equal(diff.nameCount, 1)
    assert.equal(diff.top[0].name, 'Visible')
    assert.equal(diff.olderNodes, 0)
    assert.equal(diff.newerNodes, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('malformed snapshots and the size limit fail with clear codes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-diff-'))
  try {
    const bad = join(dir, 'bad.heapsnapshot')
    await writeFile(bad, '{"snapshot":{},"nodes":[]}')
    await assert.rejects(diffHeapSnapshots(bad, bad), (error) => error.code === 'snapshot-format')

    const older = await writeSnapshot(dir, 'older.heapsnapshot', buildSnapshot({ entries: [{ name: 'Widget', count: 1, size: 8 }] }))
    const newer = await writeSnapshot(dir, 'newer.heapsnapshot', buildSnapshot({ entries: [{ name: 'Widget', count: 1, size: 8 }] }))
    await assert.rejects(diffHeapSnapshots(older, newer, { maxBytes: 16 }), (error) => error.code === 'snapshot-too-large')

    await assert.rejects(diffHeapSnapshots(join(dir, 'missing.heapsnapshot'), newer), (error) => error.code === 'snapshot-missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recentSnapshots returns the newest snapshots first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-list-'))
  try {
    const memory = new PluginMemory({ dir, config: {}, now: () => 0 })
    const older = await writeSnapshot(dir, 'heap-snapshot-a.heapsnapshot', buildSnapshot())
    const middle = await writeSnapshot(dir, 'heap-snapshot-b.heapsnapshot', buildSnapshot())
    const newest = await writeSnapshot(dir, 'heap-snapshot-c.heapsnapshot', buildSnapshot())
    await utimes(older, new Date(1000), new Date(1000))
    await utimes(middle, new Date(2000), new Date(2000))
    await utimes(newest, new Date(3000), new Date(3000))
    const files = await memory.recentSnapshots(2)
    assert.equal(files.length, 2)
    assert.equal(files[0].name, 'heap-snapshot-c.heapsnapshot')
    assert.equal(files[1].name, 'heap-snapshot-b.heapsnapshot')
    assert.ok(files[0].bytes > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})