import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CRASHPAD_MAX_FILE_BYTES,
  CRASHPAD_MAX_MEMORY_ENTRIES,
  CRASHPAD_MAX_MODULES,
  CRASHPAD_STATUS_FILES,
} from './constants.js'

/**
 * Crashpad minidump reader — deliberately narrow.
 *
 * DeepSeek Harness does not currently ship Crashpad on this machine, so the
 * probe has to treat "no directory" as a normal answer rather than an error.
 * When dumps do exist this reads the header and three small streams (modules,
 * memory info, exception) straight out of the file by offset; it never walks a
 * memory stream, because a dump can be hundreds of megabytes and the panel only
 * needs to answer "what crashed, in which module, and how much memory did the
 * process hold".
 */
const SIGNATURE = 0x504d444d // 'MDMP' little endian
const STREAM_EXCEPTION = 6
const STREAM_MODULE_LIST = 4
const STREAM_MEMORY_INFO_LIST = 16
const HEADER_BYTES = 32
const DIRECTORY_ENTRY_BYTES = 12
const MODULE_ENTRY_BYTES = 108
const MEMORY_INFO_ENTRY_BYTES = 48
const MEMORY_INFO_HEADER_BYTES = 16

const DIR_CANDIDATES = [
  ['LOCALAPPDATA', 'Crashpad', 'reports'],
  ['LOCALAPPDATA', 'Crashpad'],
  ['APPDATA', 'Crashpad', 'reports'],
  ['APPDATA', 'Crashpad'],
]

// Two segments, not one string with a backslash inside: `join` must be allowed
// to pick the separator, otherwise the same code builds a mixed-separator path
// on any non-Windows host (which is what the CI runner is).
const CRASHPAD_SUBDIR = ['@deepseek-ai', 'dsh-desktop']

export function resolveCrashpadDir(env = process.env) {
  const attempts = []
  for (const [variable, ...rest] of DIR_CANDIDATES) {
    const root = env?.[variable]
    if (typeof root !== 'string' || root.length === 0) continue
    attempts.push(join(root, ...CRASHPAD_SUBDIR, ...rest))
  }
  return { candidates: attempts, dir: attempts.length > 0 ? attempts[0] : null }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead < length) return buffer.subarray(0, bytesRead)
  return buffer
}

function readString(buffer, offset) {
  // MINIDUMP_STRING is a u32 byte length followed by UTF-16LE code units.
  if (offset + 4 > buffer.length) return null
  const length = buffer.readUInt32LE(offset)
  const start = offset + 4
  const end = Math.min(buffer.length, start + length)
  if (end - start <= 0) return ''
  return buffer.subarray(start, end).toString('utf16le').replace(/\u0000+$/, '')
}

function usableSize(bytes, fileBytes) {
  return Number.isFinite(fileBytes) ? Math.min(bytes, fileBytes) : bytes
}

async function readModuleList(handle, fileBytes, rva, dataSize) {
  const head = await readAt(handle, rva, 4)
  if (head.length < 4) return { ok: false, total: 0, modules: [], truncated: false }
  const total = head.readUInt32LE(0)
  const wanted = Math.min(total, CRASHPAD_MAX_MODULES)
  const entryBytes = Math.min(dataSize - 4, usableSize(wanted * MODULE_ENTRY_BYTES, fileBytes))
  if (entryBytes <= 0) return { ok: true, total, modules: [], truncated: false }
  const body = await readAt(handle, rva + 4, entryBytes)
  const modules = []
  for (let index = 0; index + MODULE_ENTRY_BYTES <= body.length; index += MODULE_ENTRY_BYTES) {
    const base = body.readBigUInt64LE(index)
    const size = body.readUInt32LE(index + 8)
    const stamp = body.readUInt32LE(index + 12)
    const nameRva = body.readUInt32LE(index + 16)
    modules.push({
      base: base.toString(),
      size,
      timeDateStamp: stamp,
      nameRva,
    })
  }
  return { ok: true, total, modules, truncated: total > wanted }
}

async function readModuleNames(handle, modules) {
  // Reading every name individually would be one syscall per module; the names
  // live close together, so a single 64 KiB window around the lowest RVA almost
  // always covers them all, and misses simply stay unnamed.
  if (modules.length === 0) return modules
  const rvas = modules.map((entry) => entry.nameRva).filter((value) => Number.isFinite(value) && value > 0)
  if (rvas.length === 0) return modules.map((entry) => ({ ...entry, name: null }))
  const base = Math.min(...rvas)
  const window = Buffer.allocUnsafe(64 * 1024)
  const { bytesRead } = await handle.read(window, 0, window.length, base)
  const view = window.subarray(0, bytesRead)
  return modules.map((entry) => {
    const offset = entry.nameRva - base
    if (!Number.isFinite(offset) || offset < 0 || offset >= view.length) return { ...entry, name: null }
    return { ...entry, name: readString(view, offset) }
  })
}

async function readMemoryInfo(handle, fileBytes, rva, dataSize) {
  const header = await readAt(handle, rva, MEMORY_INFO_HEADER_BYTES)
  if (header.length < MEMORY_INFO_HEADER_BYTES) return { ok: false, entries: 0, total: 0, committedBytes: 0, reservedBytes: 0, truncated: false }
  const entrySize = header.readUInt32LE(4)
  const total = Number(header.readBigUInt64LE(8))
  if (!Number.isFinite(entrySize) || entrySize < MEMORY_INFO_ENTRY_BYTES) {
    return { ok: false, entries: 0, total: Number.isFinite(total) ? total : 0, committedBytes: 0, reservedBytes: 0, truncated: false }
  }
  const wanted = Math.min(Number.isFinite(total) ? total : 0, CRASHPAD_MAX_MEMORY_ENTRIES)
  const bodyBytes = Math.min(wanted * entrySize, usableSize(dataSize - MEMORY_INFO_HEADER_BYTES, fileBytes))
  if (bodyBytes <= 0) return { ok: true, entries: 0, total: Number.isFinite(total) ? total : 0, committedBytes: 0, reservedBytes: 0, truncated: false }
  const body = await readAt(handle, rva + MEMORY_INFO_HEADER_BYTES, bodyBytes)
  let committedBytes = 0
  let reservedBytes = 0
  let entries = 0
  // MEM_STATE: 0x1000 = MEM_COMMIT, 0x2000 = MEM_RESERVE.
  for (let offset = 0; offset + entrySize <= body.length; offset += entrySize) {
    const regionSize = body.readBigUInt64LE(offset + 24)
    const state = body.readUInt32LE(offset + 32)
    const size = Number(regionSize)
    if (!Number.isFinite(size)) continue
    entries += 1
    if (state === 0x1000) committedBytes += size
    else if (state === 0x2000) reservedBytes += size
  }
  return { ok: true, entries, total: Number.isFinite(total) ? total : 0, committedBytes, reservedBytes, truncated: wanted < (Number.isFinite(total) ? total : 0) }
}

async function readException(handle, rva, dataSize) {
  const size = Math.min(dataSize, 168)
  const buffer = await readAt(handle, rva, size)
  if (buffer.length < 24) return { ok: false }
  const threadId = buffer.readUInt32LE(0)
  if (buffer.length < 32) return { ok: true, threadId, code: null, address: null }
  const code = buffer.readUInt32LE(8)
  const address = buffer.readBigUInt64LE(16)
  return {
    ok: true,
    threadId,
    code: `0x${code.toString(16).padStart(8, '0')}`,
    address: address.toString(),
    // The Windows NTSTATUS codes behind OOM and stack faults are worth naming;
    // anything else stays hex rather than pretending to know it.
    label: code === 0xc0000017 ? 'STATUS_NO_MEMORY' : code === 0xc0000409 ? 'STATUS_STACK_BUFFER_OVERRUN' : code === 0xe0434352 ? 'CLR_EXCEPTION' : null,
  }
}

export async function parseMinidump(path, { now = Date.now } = {}) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return { ok: false, path, error: error?.code ?? 'stat-failed' }
  }
  const bytes = Number(info.size)
  if (!Number.isFinite(bytes) || bytes < HEADER_BYTES) {
    return { ok: false, path, bytes, error: 'too-small' }
  }
  if (bytes > CRASHPAD_MAX_FILE_BYTES) {
    // Refuse rather than stream for minutes: the panel is a status view, not a
    // dump viewer, and a half-gigabyte parse would stall the whole request.
    return { ok: false, path, bytes, error: 'too-large', limitBytes: CRASHPAD_MAX_FILE_BYTES }
  }
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return { ok: false, path, bytes, error: error?.code ?? 'open-failed' }
  }
  try {
    const header = await readAt(handle, 0, HEADER_BYTES)
    if (header.length < HEADER_BYTES) return { ok: false, path, bytes, error: 'short-header' }
    const signature = header.readUInt32LE(0)
    if (signature !== SIGNATURE) return { ok: false, path, bytes, error: 'not-minidump' }
    const version = header.readUInt32LE(4)
    const streamCount = header.readUInt32LE(8)
    const directoryRva = header.readUInt32LE(12)
    const timeDateStamp = header.readUInt32LE(20)
    const flags = header.readBigUInt64LE(24)
    const directoryBytes = Math.min(streamCount * DIRECTORY_ENTRY_BYTES, usableSize(4096 * DIRECTORY_ENTRY_BYTES, bytes))
    const directory = directoryRva > 0 && directoryBytes > 0 ? await readAt(handle, directoryRva, directoryBytes) : Buffer.alloc(0)
    const streams = []
    for (let offset = 0; offset + DIRECTORY_ENTRY_BYTES <= directory.length; offset += DIRECTORY_ENTRY_BYTES) {
      streams.push({
        type: directory.readUInt32LE(offset),
        size: directory.readUInt32LE(offset + 4),
        rva: directory.readUInt32LE(offset + 8),
      })
    }
    const find = (type) => streams.find((entry) => entry.type === type) ?? null
    const moduleStream = find(STREAM_MODULE_LIST)
    const memoryStream = find(STREAM_MEMORY_INFO_LIST)
    const exceptionStream = find(STREAM_EXCEPTION)
    const modulesResult = moduleStream
      ? await readModuleList(handle, bytes, moduleStream.rva, moduleStream.size)
      : { ok: false, total: 0, modules: [], truncated: false }
    const modules = modulesResult.modules?.length > 0 ? await readModuleNames(handle, modulesResult.modules) : []
    const memory = memoryStream
      ? await readMemoryInfo(handle, bytes, memoryStream.rva, memoryStream.size)
      : { ok: false, entries: 0, total: 0, committedBytes: 0, reservedBytes: 0, truncated: false }
    const exception = exceptionStream ? await readException(handle, exceptionStream.rva, exceptionStream.size) : { ok: false }
    const crashTime = timeDateStamp > 0 ? timeDateStamp * 1000 : null
    const topModules = [...modules]
      .filter((entry) => entry.size > 0)
      .sort((left, right) => right.size - left.size)
      .slice(0, 5)
      .map((entry) => ({ name: entry.name, size: entry.size }))
    return {
      ok: true,
      path,
      bytes,
      modifiedAt: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
      ageMs: Number.isFinite(info.mtimeMs) && Number.isFinite(now) ? Math.max(0, now - info.mtimeMs) : null,
      crashAt: crashTime,
      version: `${(version >>> 16) & 0xffff}.${version & 0xffff}`,
      streamCount,
      flags: flags.toString(),
      exception: exception.ok ? exception : null,
      modules: {
        total: modulesResult.total,
        // Only the modules that were actually loaded are interesting; a dump of
        // a 3 GiB process can reference hundreds and the card shows the biggest.
        top: topModules,
        truncated: modulesResult.truncated === true,
      },
      memory: {
        total: memory.total,
        entries: memory.entries,
        committedBytes: memory.committedBytes,
        reservedBytes: memory.reservedBytes,
        truncated: memory.truncated === true,
      },
    }
  } catch (error) {
    return { ok: false, path, bytes, error: error?.code ?? 'parse-failed' }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function listDumps(dir, limit) {
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { ok: false, error: error?.code ?? 'readdir-failed', files: [] }
  }
  const files = []
  for (const entry of names) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.dmp')) continue
    const path = join(dir, entry.name)
    try {
      const info = await stat(path)
      files.push({ path, name: entry.name, bytes: Number(info.size), modifiedAt: Number(info.mtimeMs) })
    } catch {
      // A dump can vanish between readdir and stat (Crashpad rotates them); a
      // missing file is not worth an error line.
    }
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return { ok: true, error: null, files: files.slice(0, limit) }
}

export async function inspectCrashpad({ env = process.env, dir = null, now = Date.now, limit = CRASHPAD_STATUS_FILES } = {}) {
  const resolved = resolveCrashpadDir(env)
  const candidates = dir === null ? resolved.candidates : [dir]
  const checked = []
  for (const candidate of candidates) {
    const listing = await listDumps(candidate, Number.isFinite(limit) && limit > 0 ? limit : CRASHPAD_STATUS_FILES)
    checked.push({ dir: candidate, ok: listing.ok, error: listing.error })
    if (!listing.ok || listing.files.length === 0) continue
    const dumps = []
    for (const file of listing.files) {
      dumps.push(await parseMinidump(file.path, { now }))
    }
    return { available: true, reason: null, dir: candidate, checked, dumps, total: listing.files.length }
  }
  const reason = checked.some((entry) => entry.ok) ? 'no-dumps' : 'not-found'
  return { available: false, reason, dir: candidates[0] ?? null, checked, dumps: [], total: 0 }
}
