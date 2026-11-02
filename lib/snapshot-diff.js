import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { SNAPSHOT_DIFF_MAX_BYTES, SNAPSHOT_DIFF_MAX_NODES, SNAPSHOT_DIFF_TIMEOUT_MS, SNAPSHOT_DIFF_TOP } from './constants.js'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const MINUS = 0x2d
const ZERO = 0x30
const NINE = 0x39
const LOWER_E = 0x65
const UPPER_E = 0x45
const DOT = 0x2e
const LOWERCASE_U = 0x75

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

export class SnapshotDiffError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SnapshotDiffError'
    this.code = code
  }
}

class ByteReader {
  constructor(stream, { deadline }) {
    this.iterator = stream[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.offset = 0
    this.done = false
    this.deadline = deadline
    this.bytesRead = 0
  }

  get remaining() {
    return this.buffer.length - this.offset
  }

  async ensure(count = 1) {
    if (this.remaining >= count) return true
    while (this.remaining < count) {
      if (this.deadline !== null && Date.now() > this.deadline) {
        throw new SnapshotDiffError('snapshot-timeout', 'parsing the heap snapshot took too long')
      }
      let step
      try {
        step = await this.iterator.next()
      } catch (error) {
        throw new SnapshotDiffError('snapshot-unreadable', String(error?.message ?? error))
      }
      if (step.done === true) {
        this.done = true
        return false
      }
      const chunk = step.value
      this.bytesRead += chunk.length
      if (this.offset > 0) {
        this.buffer = this.offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(this.offset)
        this.offset = 0
      }
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    }
    return true
  }

  async peekByte() {
    if (!(await this.ensure(1))) return -1
    return this.buffer[this.offset]
  }

  async skipWhitespace() {
    for (;;) {
      if (this.remaining === 0 && !(await this.ensure(1))) return
      if (!WHITESPACE.has(this.buffer[this.offset])) return
      this.offset += 1
    }
  }

  async expect(code) {
    await this.skipWhitespace()
    const byte = await this.peekByte()
    if (byte !== code) throw new SnapshotDiffError('snapshot-format', `expected ${JSON.stringify(String.fromCharCode(code))} in the heap snapshot`)
    this.offset += 1
  }

  async readInteger() {
    let sign = 1
    if (!(await this.ensure(1))) throw new SnapshotDiffError('snapshot-format', 'unexpected end of the heap snapshot')
    if (this.buffer[this.offset] === MINUS) {
      sign = -1
      this.offset += 1
    }
    let value = 0
    let digits = 0
    for (;;) {
      if (this.remaining === 0 && !(await this.ensure(1))) break
      const byte = this.buffer[this.offset]
      if (byte >= ZERO && byte <= NINE) {
        value = value * 10 + (byte - ZERO)
        digits += 1
        this.offset += 1
        continue
      }
      if (byte === DOT || byte === LOWER_E || byte === UPPER_E) return await this.readNumberSlow(value, sign, byte)
      break
    }
    if (digits === 0) throw new SnapshotDiffError('snapshot-format', 'expected a number in the heap snapshot')
    return sign * value
  }

  async readNumberSlow(value, sign, first) {
    let text = String(value)
    let byte = first
    for (;;) {
      text += String.fromCharCode(byte)
      this.offset += 1
      if (!(await this.ensure(1))) break
      byte = this.buffer[this.offset]
      if ((byte >= ZERO && byte <= NINE) || byte === DOT || byte === LOWER_E || byte === UPPER_E || byte === MINUS || byte === 0x2b) continue
      break
    }
    const number = Number(text)
    if (!Number.isFinite(number)) throw new SnapshotDiffError('snapshot-format', 'invalid number in the heap snapshot')
    return sign * number
  }

  async readString(decode) {
    await this.skipWhitespace()
    if (!(await this.ensure(1)) || this.buffer[this.offset] !== QUOTE) {
      throw new SnapshotDiffError('snapshot-format', 'expected a string in the heap snapshot')
    }
    this.offset += 1
    const parts = decode === true ? [] : null
    for (;;) {
      if (this.remaining === 0 && !(await this.ensure(1))) {
        throw new SnapshotDiffError('snapshot-format', 'unterminated string in the heap snapshot')
      }
      const byte = this.buffer[this.offset]
      if (byte === QUOTE) {
        this.offset += 1
        return decode === true ? parts.join('') : null
      }
      if (byte === BACKSLASH) {
        this.offset += 1
        if (!(await this.ensure(1))) throw new SnapshotDiffError('snapshot-format', 'unterminated escape in the heap snapshot')
        const escaped = this.buffer[this.offset]
        this.offset += 1
        if (decode !== true) {
          if (escaped === LOWERCASE_U) {
            if (!(await this.ensure(4))) throw new SnapshotDiffError('snapshot-format', 'truncated unicode escape')
            this.offset += 4
          }
          continue
        }
        if (escaped === LOWERCASE_U) {
          if (!(await this.ensure(4))) throw new SnapshotDiffError('snapshot-format', 'truncated unicode escape')
          let code = 0
          for (let i = 0; i < 4; i += 1) {
            code = code * 16 + hexValue(this.buffer[this.offset + i])
            this.offset += 1
          }
          parts.push(String.fromCharCode(code))
          continue
        }
        parts.push(unescapeByte(escaped))
        continue
      }
      if (decode !== true) {
        this.offset += 1
        continue
      }
      if (byte < 0x80) {
        parts.push(String.fromCharCode(byte))
        this.offset += 1
        continue
      }
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
      if (!(await this.ensure(length))) throw new SnapshotDiffError('snapshot-format', 'truncated UTF-8 sequence')
      parts.push(String.fromCodePoint(decodeUtf8(this.buffer, this.offset, length)))
      this.offset += length
    }
  }
}

function hexValue(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  return 0
}

function unescapeByte(byte) {
  switch (byte) {
    case 0x62:
      return '\b'
    case 0x66:
      return '\f'
    case 0x6e:
      return '\n'
    case 0x72:
      return '\r'
    case 0x74:
      return '\t'
    default:
      return String.fromCharCode(byte)
  }
}

function decodeUtf8(buffer, offset, length) {
  if (length === 2) return ((buffer[offset] & 0x1f) << 6) | (buffer[offset + 1] & 0x3f)
  if (length === 3) return ((buffer[offset] & 0x0f) << 12) | ((buffer[offset + 1] & 0x3f) << 6) | (buffer[offset + 2] & 0x3f)
  return ((buffer[offset] & 0x07) << 18) | ((buffer[offset + 1] & 0x3f) << 12) | ((buffer[offset + 2] & 0x3f) << 6) | (buffer[offset + 3] & 0x3f)
}

async function parseValue(reader) {
  const byte = await reader.peekByte()
  if (byte === -1) throw new SnapshotDiffError('snapshot-format', 'unexpected end of the heap snapshot')
  if (byte === QUOTE) return await reader.readString(true)
  if (byte === OPEN_BRACE) return await parseObject(reader)
  if (byte === OPEN_BRACKET) return await parseArray(reader)
  if (byte === 0x74) return await readLiteral(reader, 'true', true)
  if (byte === 0x66) return await readLiteral(reader, 'false', false)
  if (byte === 0x6e) return await readLiteral(reader, 'null', null)
  return await reader.readInteger()
}

async function parseObject(reader) {
  await reader.expect(OPEN_BRACE)
  const value = {}
  for (;;) {
    await reader.skipWhitespace()
    const byte = await reader.peekByte()
    if (byte === CLOSE_BRACE) {
      reader.offset += 1
      return value
    }
    const key = await reader.readString(true)
    await reader.expect(COLON)
    value[key] = await parseValue(reader)
    await reader.skipWhitespace()
    const separator = await reader.peekByte()
    if (separator === COMMA) {
      reader.offset += 1
      continue
    }
    if (separator === CLOSE_BRACE) {
      reader.offset += 1
      return value
    }
    throw new SnapshotDiffError('snapshot-format', 'malformed object in the heap snapshot')
  }
}

async function parseArray(reader) {
  await reader.expect(OPEN_BRACKET)
  const value = []
  for (;;) {
    await reader.skipWhitespace()
    const byte = await reader.peekByte()
    if (byte === CLOSE_BRACKET) {
      reader.offset += 1
      return value
    }
    value.push(await parseValue(reader))
    await reader.skipWhitespace()
    const separator = await reader.peekByte()
    if (separator === COMMA) {
      reader.offset += 1
      continue
    }
    if (separator === CLOSE_BRACKET) {
      reader.offset += 1
      return value
    }
    throw new SnapshotDiffError('snapshot-format', 'malformed array in the heap snapshot')
  }
}

async function readLiteral(reader, text, value) {
  for (let i = 0; i < text.length; i += 1) {
    if (!(await reader.ensure(1))) throw new SnapshotDiffError('snapshot-format', 'unexpected end of the heap snapshot')
    if (reader.buffer[reader.offset] !== text.charCodeAt(i)) throw new SnapshotDiffError('snapshot-format', 'malformed literal in the heap snapshot')
    reader.offset += 1
  }
  return value
}

async function skipValue(reader) {
  const byte = await reader.peekByte()
  if (byte === QUOTE) {
    await reader.readString(false)
    return
  }
  if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
    let depth = 0
    for (;;) {
      if (reader.remaining === 0 && !(await reader.ensure(1))) {
        throw new SnapshotDiffError('snapshot-format', 'unexpected end of the heap snapshot')
      }
      const current = reader.buffer[reader.offset]
      if (current === QUOTE) {
        await reader.readString(false)
        continue
      }
      if (current === OPEN_BRACE || current === OPEN_BRACKET) {
        depth += 1
        reader.offset += 1
        continue
      }
      if (current === CLOSE_BRACE || current === CLOSE_BRACKET) {
        depth -= 1
        reader.offset += 1
        if (depth === 0) return
        continue
      }
      reader.offset += 1
    }
  }
  let digits = 0
  for (;;) {
    if (reader.remaining === 0 && !(await reader.ensure(1))) break
    const current = reader.buffer[reader.offset]
    if (WHITESPACE.has(current) || current === COMMA || current === CLOSE_BRACE || current === CLOSE_BRACKET) break
    digits += 1
    reader.offset += 1
  }
  if (digits === 0) throw new SnapshotDiffError('snapshot-format', 'malformed value in the heap snapshot')
}

async function parseNodes(reader, snapshot) {
  const meta = snapshot?.meta
  const fields = Array.isArray(meta?.node_fields) ? meta.node_fields : null
  if (fields === null || fields.length === 0) throw new SnapshotDiffError('snapshot-format', 'the heap snapshot is missing node_fields')
  const nameField = fields.indexOf('name')
  const sizeField = fields.indexOf('self_size')
  const typeField = fields.indexOf('type')
  if (nameField < 0 || sizeField < 0) throw new SnapshotDiffError('snapshot-format', 'the heap snapshot is missing name or self_size fields')
  const count = Number(snapshot.node_count)
  if (!Number.isInteger(count) || count < 0 || count > SNAPSHOT_DIFF_MAX_NODES) {
    throw new SnapshotDiffError('snapshot-too-large', `the heap snapshot declares ${String(snapshot.node_count)} nodes`)
  }
  const names = new Uint32Array(count)
  const sizes = new Uint32Array(count)
  const types = new Uint8Array(count)
  types.fill(255)
  let maxName = 0
  await reader.expect(OPEN_BRACKET)
  let field = 0
  let index = 0
  for (;;) {
    await reader.skipWhitespace()
    const byte = await reader.peekByte()
    if (byte === CLOSE_BRACKET) {
      reader.offset += 1
      break
    }
    const value = await reader.readInteger()
    if (index >= count) throw new SnapshotDiffError('snapshot-format', 'the heap snapshot has more nodes than declared')
    if (field === nameField) {
      const nameIndex = value < 0 ? 0 : value
      names[index] = nameIndex
      if (nameIndex > maxName) maxName = nameIndex
    } else if (field === sizeField) {
      sizes[index] = value < 0 ? 0 : value
    } else if (field === typeField) {
      types[index] = value < 0 || value > 254 ? 255 : value
    }
    field += 1
    if (field === fields.length) {
      field = 0
      index += 1
    }
    await reader.skipWhitespace()
    const separator = await reader.peekByte()
    if (separator === COMMA) {
      reader.offset += 1
      continue
    }
    if (separator === CLOSE_BRACKET) {
      reader.offset += 1
      break
    }
    throw new SnapshotDiffError('snapshot-format', 'malformed nodes array in the heap snapshot')
  }
  if (field !== 0 || index !== count) throw new SnapshotDiffError('snapshot-format', 'the node count does not match node_count')
  const needed = new Uint8Array(maxName + 1)
  for (let i = 0; i < count; i += 1) needed[names[i]] = 1
  return { names, sizes, types, needed }
}

async function parseStrings(reader, needed) {
  const map = new Map()
  await reader.expect(OPEN_BRACKET)
  let index = 0
  for (;;) {
    await reader.skipWhitespace()
    const byte = await reader.peekByte()
    if (byte === CLOSE_BRACKET) {
      reader.offset += 1
      break
    }
    if (byte !== QUOTE) throw new SnapshotDiffError('snapshot-format', 'the strings array contains a non-string value')
    const wanted = index < needed.length && needed[index] === 1
    const value = await reader.readString(wanted)
    if (wanted) map.set(index, value)
    index += 1
    await reader.skipWhitespace()
    const separator = await reader.peekByte()
    if (separator === COMMA) {
      reader.offset += 1
      continue
    }
    if (separator === CLOSE_BRACKET) {
      reader.offset += 1
      break
    }
    throw new SnapshotDiffError('snapshot-format', 'malformed strings array in the heap snapshot')
  }
  return map
}

function sanitizeName(name) {
  if (typeof name !== 'string' || name.length === 0) return null
  if (name.charCodeAt(0) === 0x28) return null
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean
}

function aggregateNodes(parsed, typeNames) {
  const byName = new Map()
  let includedNodes = 0
  let includedBytes = 0
  for (let i = 0; i < parsed.names.length; i += 1) {
    const typeIndex = parsed.types[i]
    if (typeIndex !== 255) {
      const typeName = typeNames[typeIndex]
      if (typeName === 'hidden' || typeName === 'synthetic') continue
    }
    const name = sanitizeName(parsed.strings.get(parsed.names[i]))
    if (name === null) continue
    const entry = byName.get(name)
    if (entry === undefined) {
      byName.set(name, { bytes: parsed.sizes[i], count: 1 })
    } else {
      entry.bytes += parsed.sizes[i]
      entry.count += 1
    }
    includedNodes += 1
    includedBytes += parsed.sizes[i]
  }
  return { byName, includedNodes, includedBytes }
}

async function summarizeSnapshotFile(path, options) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new SnapshotDiffError('snapshot-missing', String(error?.message ?? error))
  }
  if (!info.isFile()) throw new SnapshotDiffError('snapshot-missing', 'the heap snapshot path is not a file')
  if (info.size > options.maxBytes) throw new SnapshotDiffError('snapshot-too-large', `the heap snapshot is ${info.size} bytes`)
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  const reader = new ByteReader(stream, { deadline: options.deadline })
  try {
    await reader.expect(OPEN_BRACE)
    let snapshot = null
    let nodes = null
    let strings = null
    for (;;) {
      await reader.skipWhitespace()
      const byte = await reader.peekByte()
      if (byte === CLOSE_BRACE) {
        reader.offset += 1
        break
      }
      const key = await reader.readString(true)
      await reader.expect(COLON)
      await reader.skipWhitespace()
      if (key === 'snapshot') {
        if (nodes !== null) throw new SnapshotDiffError('snapshot-format', 'the snapshot metadata must come before nodes')
        snapshot = await parseValue(reader)
      } else if (key === 'nodes') {
        if (snapshot === null) throw new SnapshotDiffError('snapshot-format', 'the heap snapshot has no metadata before nodes')
        nodes = await parseNodes(reader, snapshot)
      } else if (key === 'strings') {
        if (nodes === null) throw new SnapshotDiffError('snapshot-format', 'the strings array must come after nodes')
        strings = await parseStrings(reader, nodes.needed)
      } else {
        await skipValue(reader)
      }
      await reader.skipWhitespace()
      const separator = await reader.peekByte()
      if (separator === COMMA) {
        reader.offset += 1
        continue
      }
      if (separator === CLOSE_BRACE) {
        reader.offset += 1
        break
      }
      throw new SnapshotDiffError('snapshot-format', 'malformed top-level object in the heap snapshot')
    }
    if (snapshot === null || nodes === null || strings === null) {
      throw new SnapshotDiffError('snapshot-format', 'the heap snapshot is missing snapshot, nodes or strings')
    }
    const typeNames = Array.isArray(snapshot.meta?.node_types?.[0]) ? snapshot.meta.node_types[0] : []
    const aggregate = aggregateNodes({ ...nodes, strings }, typeNames)
    return {
      file: { name: basename(path), bytes: info.size, at: info.mtimeMs },
      ...aggregate,
    }
  } finally {
    stream.destroy()
  }
}

export async function diffHeapSnapshots(olderPath, newerPath, options = {}) {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_DIFF_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? SNAPSHOT_DIFF_MAX_BYTES
  const top = options.top ?? SNAPSHOT_DIFF_TOP
  const deadline = startedAt + timeoutMs
  const older = await summarizeSnapshotFile(olderPath, { deadline, maxBytes })
  const newer = await summarizeSnapshotFile(newerPath, { deadline, maxBytes })
  const changes = []
  const names = new Set([...older.byName.keys(), ...newer.byName.keys()])
  let olderBytes = 0
  let newerBytes = 0
  for (const name of names) {
    const before = older.byName.get(name) ?? { bytes: 0, count: 0 }
    const after = newer.byName.get(name) ?? { bytes: 0, count: 0 }
    olderBytes += before.bytes
    newerBytes += after.bytes
    if (before.bytes === after.bytes && before.count === after.count) continue
    changes.push({
      name,
      olderBytes: before.bytes,
      newerBytes: after.bytes,
      deltaBytes: after.bytes - before.bytes,
      olderCount: before.count,
      newerCount: after.count,
    })
  }
  changes.sort((left, right) => Math.abs(right.deltaBytes) - Math.abs(left.deltaBytes) || right.newerBytes - left.newerBytes)
  return {
    older: older.file,
    newer: newer.file,
    olderBytes,
    newerBytes,
    deltaBytes: newerBytes - olderBytes,
    olderNodes: older.includedNodes,
    newerNodes: newer.includedNodes,
    nodeDelta: newer.includedNodes - older.includedNodes,
    top: changes.slice(0, top),
    nameCount: names.size,
    elapsedMs: Date.now() - startedAt,
  }
}