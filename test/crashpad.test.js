import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectCrashpad, parseMinidump, resolveCrashpadDir } from '../lib/crashpad.js'
import { CRASHPAD_MAX_FILE_BYTES } from '../lib/constants.js'

/**
 * Building a real minidump in the test is the only way to prove the offsets are
 * right: a fixture blob in the repo would be opaque, and mocking the reader
 * would only test the mock.
 */
const SIGNATURE = 0x504d444d
const HEADER_BYTES = 32
const DIRECTORY_ENTRY_BYTES = 12
const MODULE_ENTRY_BYTES = 108
const MEMORY_INFO_ENTRY_BYTES = 48
const MEMORY_INFO_HEADER_BYTES = 16
const STREAM_MODULE_LIST = 4
const STREAM_EXCEPTION = 6
const STREAM_MEMORY_INFO_LIST = 16

function moduleBody(modules, nameRvas) {
  const body = Buffer.alloc(4 + modules.length * MODULE_ENTRY_BYTES)
  body.writeUInt32LE(modules.length, 0)
  modules.forEach((module, index) => {
    const at = 4 + index * MODULE_ENTRY_BYTES
    body.writeBigUInt64LE(BigInt(module.base), at)
    body.writeUInt32LE(module.size, at + 8)
    body.writeUInt32LE(0, at + 12)
    body.writeUInt32LE(nameRvas[index] ?? 0, at + 16)
  })
  return body
}

function memoryBody(regions) {
  const body = Buffer.alloc(MEMORY_INFO_HEADER_BYTES + regions.length * MEMORY_INFO_ENTRY_BYTES)
  body.writeUInt32LE(0x10000, 0)
  body.writeUInt32LE(MEMORY_INFO_ENTRY_BYTES, 4)
  body.writeBigUInt64LE(BigInt(regions.length), 8)
  regions.forEach((region, index) => {
    const at = MEMORY_INFO_HEADER_BYTES + index * MEMORY_INFO_ENTRY_BYTES
    body.writeBigUInt64LE(BigInt(region.size), at + 24)
    body.writeUInt32LE(region.state, at + 32)
  })
  return body
}

function exceptionBody({ threadId = 1, code = 0xc0000017, address = 0x1234n } = {}) {
  const body = Buffer.alloc(168)
  body.writeUInt32LE(threadId, 0)
  body.writeUInt32LE(0, 4)
  body.writeUInt32LE(code, 8)
  body.writeUInt32LE(0, 12)
  body.writeBigUInt64LE(address, 16)
  return body
}

function nameEntry(name) {
  const text = Buffer.from(name + '\u0000', 'utf16le')
  const entry = Buffer.alloc(4 + text.length)
  entry.writeUInt32LE(text.length, 0)
  text.copy(entry, 4)
  return entry
}

function buildDump({ modules = null, regions = null, exception = null, stamp = 1_700_000_000, version = 0x00000000 } = {}) {
  const streams = []
  if (modules !== null) streams.push({ type: STREAM_MODULE_LIST })
  if (exception !== null) streams.push({ type: STREAM_EXCEPTION })
  if (regions !== null) streams.push({ type: STREAM_MEMORY_INFO_LIST })

  const names = modules === null ? [] : modules.map((entry) => nameEntry(entry.name))
  // Two-pass layout: stream bodies come first, so their lengths (which do not
  // depend on the name RVAs) fix where the names can start.
  const directoryEnd = HEADER_BYTES + streams.length * DIRECTORY_ENTRY_BYTES
  const bodyLengths = streams.map((stream) => {
    if (stream.type === STREAM_MODULE_LIST) return 4 + modules.length * MODULE_ENTRY_BYTES
    if (stream.type === STREAM_MEMORY_INFO_LIST) return MEMORY_INFO_HEADER_BYTES + regions.length * MEMORY_INFO_ENTRY_BYTES
    return 168
  })
  const nameStart = directoryEnd + bodyLengths.reduce((sum, size) => sum + size, 0)
  const nameRvas = []
  let nameCursor = nameStart
  for (const entry of names) {
    nameRvas.push(nameCursor)
    nameCursor += entry.length
  }

  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(SIGNATURE, 0)
  header.writeUInt32LE(version, 4)
  header.writeUInt32LE(streams.length, 8)
  header.writeUInt32LE(HEADER_BYTES, 12)
  header.writeUInt32LE(stamp, 20)
  header.writeBigUInt64LE(0n, 24)

  const directory = Buffer.alloc(streams.length * DIRECTORY_ENTRY_BYTES)
  const bodies = []
  let cursor = directoryEnd
  streams.forEach((stream, index) => {
    let body
    if (stream.type === STREAM_MODULE_LIST) body = moduleBody(modules, nameRvas)
    else if (stream.type === STREAM_MEMORY_INFO_LIST) body = memoryBody(regions)
    else body = exceptionBody(exception)
    directory.writeUInt32LE(stream.type, index * DIRECTORY_ENTRY_BYTES)
    directory.writeUInt32LE(body.length, index * DIRECTORY_ENTRY_BYTES + 4)
    directory.writeUInt32LE(cursor, index * DIRECTORY_ENTRY_BYTES + 8)
    cursor += body.length
    bodies.push(body)
  })

  return Buffer.concat([header, directory, ...bodies, ...names])
}

async function withTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('the crashpad directory is resolved under the dsh desktop app data folder', () => {
  const resolved = resolveCrashpadDir({
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
  })
  assert.equal(resolved.candidates.length, 4)
  assert.match(resolved.candidates[0], /AppData\\Local/)
  assert.match(resolved.candidates[0], /@deepseek-ai\\dsh-desktop/)
  assert.match(resolved.candidates[0], /Crashpad\\reports$/)
  assert.equal(resolved.dir, resolved.candidates[0])
  // With no environment at all there is nothing to probe, and that is not a crash.
  assert.deepEqual(resolveCrashpadDir({}), { candidates: [], dir: null })
})

test('a real minidump yields its exception, modules and memory totals', async () => {
  const buffer = buildDump({
    modules: [
      { base: 0x10000000, size: 1024 * 1024, name: 'tiny.dll' },
      { base: 0x20000000, size: 64 * 1024 * 1024, name: 'big.dll' },
    ],
    regions: [
      { size: 1024 ** 3, state: 0x1000 },
      { size: 2 * 1024 ** 3, state: 0x1000 },
      { size: 512 * 1024 ** 2, state: 0x2000 },
    ],
    exception: { threadId: 7, code: 0xc0000017 },
  })
  const temp = await withTempDir('wd-crashpad-')
  const path = join(temp.dir, 'abc.dmp')
  try {
    await writeFile(path, buffer)
    const result = await parseMinidump(path)
    assert.equal(result.ok, true)
    assert.equal(result.version, '0.0')
    assert.equal(result.streamCount, 3)
    assert.equal(result.bytes, buffer.length)
    assert.equal(result.exception.threadId, 7)
    assert.equal(result.exception.code, '0xc0000017')
    assert.equal(result.exception.label, 'STATUS_NO_MEMORY')
    assert.equal(result.modules.total, 2)
    // Sorted by size so the card shows the largest offenders first.
    assert.equal(result.modules.top[0].name, 'big.dll')
    assert.equal(result.modules.top[0].size, 64 * 1024 * 1024)
    assert.equal(result.modules.top[1].name, 'tiny.dll')
    assert.equal(result.memory.entries, 3)
    assert.equal(result.memory.committedBytes, 3 * 1024 ** 3)
    assert.equal(result.memory.reservedBytes, 512 * 1024 ** 2)
    assert.equal(result.memory.truncated, false)
    assert.equal(result.crashAt, 1_700_000_000 * 1000)
  } finally {
    await temp.cleanup()
  }
})

test('a file without the MDMP signature is refused rather than misread', async () => {
  const temp = await withTempDir('wd-bad-')
  try {
    const path = join(temp.dir, 'x.dmp')
    await writeFile(path, Buffer.alloc(64, 0x41))
    const result = await parseMinidump(path)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'not-minidump')
  } finally {
    await temp.cleanup()
  }
})

test('a missing or truncated file is a plain error, never a thrown exception', async () => {
  const temp = await withTempDir('wd-short-')
  try {
    const path = join(temp.dir, 'tiny.dmp')
    await writeFile(path, Buffer.from('MDMP'))
    assert.equal((await parseMinidump(path)).error, 'too-small')
  } finally {
    await temp.cleanup()
  }
  const missing = await parseMinidump(join(tmpdir(), 'nope-' + Date.now() + '.dmp'))
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'ENOENT')
})

test('the file size limit is the documented 512 MiB', () => {
  // The guard is on stat size, so an enormous dump is refused without ever being
  // read into memory.
  assert.equal(CRASHPAD_MAX_FILE_BYTES, 512 * 1024 * 1024)
})

test('a dump with no streams at all still parses into an empty report', async () => {
  const temp = await withTempDir('wd-empty-streams-')
  try {
    const path = join(temp.dir, 'empty.dmp')
    await writeFile(path, buildDump({}))
    const result = await parseMinidump(path)
    assert.equal(result.ok, true)
    assert.equal(result.exception, null)
    assert.equal(result.modules.total, 0)
    assert.equal(result.memory.entries, 0)
  } finally {
    await temp.cleanup()
  }
})

test('inspectCrashpad reports not-found when DSH never enabled dumps', async () => {
  const temp = await withTempDir('wd-no-crashpad-')
  try {
    const result = await inspectCrashpad({ env: {}, dir: join(temp.dir, 'Crashpad', 'reports') })
    assert.equal(result.available, false)
    assert.equal(result.reason, 'not-found')
    assert.deepEqual(result.dumps, [])
    assert.equal(result.checked.length, 1)
  } finally {
    await temp.cleanup()
  }
})

test('an existing directory with no .dmp files says no-dumps, not not-found', async () => {
  const temp = await withTempDir('wd-empty-crashpad-')
  try {
    await writeFile(join(temp.dir, 'notes.txt'), 'not a dump')
    const result = await inspectCrashpad({ env: {}, dir: temp.dir })
    assert.equal(result.available, false)
    assert.equal(result.reason, 'no-dumps')
  } finally {
    await temp.cleanup()
  }
})

test('dumps are scanned together and one bad file does not fail the scan', async () => {
  const temp = await withTempDir('wd-dumps-')
  try {
    const good = buildDump({ exception: {} })
    await writeFile(join(temp.dir, 'a.dmp'), good)
    await writeFile(join(temp.dir, 'b.dmp'), good)
    await writeFile(join(temp.dir, 'bad.dmp'), Buffer.alloc(128, 0))
    await writeFile(join(temp.dir, 'ignored.txt'), 'x')
    const result = await inspectCrashpad({ env: {}, dir: temp.dir, limit: 3 })
    assert.equal(result.available, true)
    assert.equal(result.reason, null)
    assert.equal(result.dumps.length, 3, 'the .txt file is not a dump')
    assert.equal(result.total, 3)
    const ok = result.dumps.filter((dump) => dump.ok === true)
    const bad = result.dumps.filter((dump) => dump.ok === false)
    assert.equal(ok.length, 2)
    assert.equal(bad.length, 1)
    assert.equal(bad[0].error, 'not-minidump')
    for (const dump of ok) assert.equal(dump.exception.label, 'STATUS_NO_MEMORY')
  } finally {
    await temp.cleanup()
  }
})

test('the dump limit caps how many files are opened per scan', async () => {
  const temp = await withTempDir('wd-limit-')
  try {
    const good = buildDump({ exception: {} })
    for (const name of ['a.dmp', 'b.dmp', 'c.dmp']) await writeFile(join(temp.dir, name), good)
    const result = await inspectCrashpad({ env: {}, dir: temp.dir, limit: 2 })
    assert.equal(result.dumps.length, 2)
    assert.equal(result.total, 2)
  } finally {
    await temp.cleanup()
  }
})

test('a wrong signature is reported per file, not as a scan failure', async () => {
  const temp = await withTempDir('wd-one-bad-')
  try {
    await writeFile(join(temp.dir, 'bad.dmp'), Buffer.alloc(128, 0))
    const result = await inspectCrashpad({ env: {}, dir: temp.dir })
    assert.equal(result.available, true)
    assert.equal(result.dumps.length, 1)
    assert.equal(result.dumps[0].ok, false)
    assert.equal(result.dumps[0].error, 'not-minidump')
  } finally {
    await temp.cleanup()
  }
})

test('the reader never writes to the crashpad directory', async () => {
  const temp = await withTempDir('wd-readonly-')
  try {
    await writeFile(join(temp.dir, 'a.dmp'), buildDump({ exception: {} }))
    await inspectCrashpad({ env: {}, dir: temp.dir })
    assert.deepEqual(await readdir(temp.dir), ['a.dmp'], 'a read must not create, rotate or delete anything')
  } finally {
    await temp.cleanup()
  }
})
