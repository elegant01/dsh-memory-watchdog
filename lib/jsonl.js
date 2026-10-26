import { COLLECTOR_MAX_BUFFER_BYTES, COLLECTOR_MAX_LINE_BYTES } from './constants.js'
import { isValidSample } from './pressure.js'

export class BoundedLineReader {
  constructor({
    maxLineBytes = COLLECTOR_MAX_LINE_BYTES,
    maxBufferBytes = COLLECTOR_MAX_BUFFER_BYTES,
    onLine,
    onError,
  } = {}) {
    this.maxLineBytes = maxLineBytes
    this.maxBufferBytes = maxBufferBytes
    this.onLine = onLine
    this.onError = onError
    this.buffer = ''
    this.discarding = false
  }

  push(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return
    if (this.discarding) {
      const newline = chunk.indexOf('\n')
      if (newline < 0) return
      chunk = chunk.slice(newline + 1)
      this.discarding = false
      if (chunk.length === 0) return
    }
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferBytes) {
          this.buffer = ''
          this.discarding = true
          this.onError?.('buffer-overflow')
        }
        return
      }
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) continue
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.onError?.('line-too-long')
        continue
      }
      this.onLine?.(line)
    }
  }

  end() {
    const rest = this.buffer
    this.buffer = ''
    if (rest.length > 0 && !this.discarding) {
      const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
      if (line.length > 0 && Buffer.byteLength(line, 'utf8') <= this.maxLineBytes) this.onLine?.(line)
    }
    this.discarding = false
  }
}

function boundedText(value, max = 300) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export function parseCollectorSample(line, now = Date.now()) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return { error: 'malformed-json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'malformed-object' }
  }
  if (parsed.ok !== true) {
    return { error: `collector-error: ${boundedText(parsed.error ?? 'unspecified')}` }
  }
  const sample = {
    ts: Number.isFinite(parsed.ts) && parsed.ts > 0 ? parsed.ts : now,
    commitUsed: parsed.commitUsed,
    commitLimit: parsed.commitLimit,
    physicalTotal: parsed.physicalTotal,
    physicalAvailable: parsed.physicalAvailable,
  }
  if (!isValidSample(sample)) return { error: 'invalid-sample' }
  return { sample }
}
