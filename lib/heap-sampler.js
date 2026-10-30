import { Session } from 'node:inspector'
import { writeFile } from 'node:fs/promises'
import v8 from 'node:v8'
import { sleep, safeErrorMessage } from './util.js'

const NATIVE_KEY = '(native)'
const BUILTIN_KEY = '(builtin)'
const UNKNOWN_KEY = '(unknown)'

let availability = null

/**
 * V8 heap sampling works only while a debugger/inspector session can be opened.
 * Electron main processes normally allow it; some hardened environments do not.
 */
export function inspectorAvailable() {
  if (availability !== null) return availability
  let session = null
  try {
    session = new Session()
    session.connect()
    availability = true
  } catch {
    availability = false
  } finally {
    if (session !== null) {
      try {
        session.disconnect()
      } catch {}
    }
  }
  return availability
}

/** Cheap, non-invasive numbers that can be polled at any time. */
export function memorySnapshot() {
  const usage = process.memoryUsage()
  let statistics = null
  try {
    statistics = v8.getHeapStatistics()
  } catch {}
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers ?? 0,
    malloced: statistics === null ? null : statistics.malloced_memory,
    peakMalloced: statistics === null ? null : statistics.peak_malloced_memory,
  }
}

/**
 * Normalizes a script URL (file:///..., app.asar path, node: builtin) into a
 * package key. Returns null when the frame carries no useful attribution.
 */
export function packageFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null
  let url = rawUrl
  if (url.startsWith('file://')) {
    url = url.slice('file://'.length)
    try {
      url = decodeURIComponent(url)
    } catch {}
  }
  url = url.replace(/\\/g, '/')
  if (url.startsWith('node:')) return { key: BUILTIN_KEY, name: BUILTIN_KEY, kind: 'builtin' }
  if (url.endsWith('(native)')) return { key: NATIVE_KEY, name: NATIVE_KEY, kind: 'native' }

  const nodeModules = url.lastIndexOf('/node_modules/')
  if (nodeModules !== -1) {
    const rest = url.slice(nodeModules + '/node_modules/'.length)
    const parts = rest.split('/')
    if (parts.length > 0 && parts[0].length > 0) {
      if (parts[0].startsWith('@') && parts.length > 1) {
        const name = parts[0] + '/' + parts[1]
        return { key: name, name, kind: 'npm' }
      }
      return { key: parts[0], name: parts[0], kind: 'npm' }
    }
  }

  const asarDsh = url.indexOf('/app.asar/dsh/')
  if (asarDsh !== -1) {
    const rest = url.slice(asarDsh + '/app.asar/dsh/'.length)
    const name = rest.split('/')[0]
    if (name) return { key: name, name, kind: 'asar' }
  }

  const sourceSnapshot = url.indexOf('/.dsh-src/')
  if (sourceSnapshot !== -1) {
    const rest = url.slice(sourceSnapshot + '/.dsh-src/'.length)
    const parts = rest.split('/')
    if (parts[0].startsWith('@') && parts.length > 1) {
      const name = parts[0] + '/' + parts[1]
      return { key: name, name, kind: 'source' }
    }
    if (parts[0]) return { key: parts[0], name: parts[0], kind: 'source' }
  }

  if (url.startsWith('node:')) return { key: BUILTIN_KEY, name: BUILTIN_KEY, kind: 'builtin' }
  if (/^(?:[A-Za-z]:)?\//.test(url)) return { key: '(local)', name: '(local)', kind: 'local' }
  return null
}

/** Frames inside our own package are reported separately, not as a "plugin". */
export function isOwnPackage(key, ownPackage) {
  return typeof ownPackage === 'string' && ownPackage.length > 0 && key === ownPackage
}

function createBucket(key, name, kind) {
  return { key, name, kind, bytes: 0, nodes: 0, top: [] }
}

/**
 * Aggregates a HeapProfiler sampling profile into per-package selfSize bytes.
 * Nodes without a JS frame inherit the nearest JS ancestor's package, so
 * "(native)" does not swallow a plugin's backing stores.
 */
export function aggregateProfile(profile) {
  const result = {
    totalBytes: 0,
    attributedBytes: 0,
    nativeBytes: 0,
    packages: [],
  }
  if (profile === null || typeof profile !== 'object' || profile.head === undefined) return result

  const buckets = new Map()
  const stack = [{ node: profile.head, owner: null }]
  const seen = new Set()

  while (stack.length > 0) {
    const frame = stack.pop()
    const node = frame.node
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    const callFrame = node.callFrame ?? {}
    const selfSize = typeof node.selfSize === 'number' ? node.selfSize : 0
    result.totalBytes += selfSize

    let owner = frame.owner
    const fromUrl = packageFromUrl(callFrame.url)
    if (fromUrl !== null) owner = fromUrl
    else if (typeof callFrame.functionName === 'string' && callFrame.functionName.length > 0) {
      owner = frame.owner
    }

    if (owner !== null) {
      const bucket = buckets.get(owner.key) ?? createBucket(owner.key, owner.name, owner.kind)
      bucket.bytes += selfSize
      bucket.nodes += 1
      if (typeof callFrame.functionName === 'string' && callFrame.functionName.length > 0) {
        bucket.top.push({ functionName: callFrame.functionName, line: callFrame.lineNumber, bytes: selfSize })
      }
      buckets.set(owner.key, bucket)
      result.attributedBytes += selfSize
    } else {
      result.nativeBytes += selfSize
    }

    const children = Array.isArray(node.children) ? node.children : []
    for (let index = 0; index < children.length; index += 1) {
      stack.push({ node: children[index], owner })
    }
  }

  for (const bucket of buckets.values()) {
    bucket.top.sort((left, right) => right.bytes - left.bytes)
    bucket.top = bucket.top.slice(0, 5)
    result.packages.push({ key: bucket.key, name: bucket.name, kind: bucket.kind, bytes: bucket.bytes, nodes: bucket.nodes, top: bucket.top })
  }
  result.packages.sort((left, right) => right.bytes - left.bytes)
  return result
}

/**
 * Runs one sampling window. Rejects with a readable message when the inspector
 * session cannot be opened, so callers can fall back to structural metrics.
 */
export async function sampleHeap({ durationMs = 20_000, samplingInterval = 4096 } = {}) {
  const session = new Session()
  session.connect()
  const startedAt = Date.now()
  let profile = null
  let failure = null
  try {
    await new Promise((resolve, reject) => {
      session.post('HeapProfiler.startSampling', { samplingInterval }, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    await sleep(durationMs)
    profile = await new Promise((resolve, reject) => {
      session.post('HeapProfiler.stopSampling', (error, value) => {
        if (error) reject(error)
        else resolve(value?.profile ?? null)
      })
    })
  } catch (error) {
    failure = error
  } finally {
    try {
      session.disconnect()
    } catch {}
  }
  if (failure !== null) {
    throw new Error('heap sampling failed: ' + safeErrorMessage(failure))
  }
  const elapsedMs = Math.max(1, Date.now() - startedAt)
  return {
    profile,
    elapsedMs,
    samplingInterval,
    aggregate: aggregateProfile(profile),
  }
}

export async function writeHeapProfile(profile, path) {
  await writeFile(path, JSON.stringify(profile), 'utf8')
  return path
}

/** Forces a full heap snapshot; synchronous and can double RSS for a moment. */
export function takeHeapSnapshot(path) {
  const startedAt = Date.now()
  const written = v8.writeHeapSnapshot(path)
  return { path: written, elapsedMs: Math.max(0, Date.now() - startedAt) }
}

export const HEAP_BUCKETS = { NATIVE_KEY, BUILTIN_KEY, UNKNOWN_KEY }