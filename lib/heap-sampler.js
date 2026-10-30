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
  return { key, name, kind, bytes: 0, nodes: 0, sites: new Map() }
}

function stripUrl(rawUrl) {
  let url = rawUrl
  if (url.startsWith('file://')) {
    url = url.slice('file://'.length)
    try {
      url = decodeURIComponent(url)
    } catch {}
  }
  return url.replace(/\\/g, '/')
}

/**
 * Turns an allocation site URL into something a reader can act on:
 * "node_modules/dsh-ops/lib/index.js" becomes "lib/index.js", an app.asar
 * entry becomes "<package>/lib/...", and a loose script keeps its file name.
 */
export function siteFile(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null
  const url = stripUrl(rawUrl)
  if (url.startsWith('node:')) return null

  let rest = null
  const nodeModules = url.lastIndexOf('/node_modules/')
  if (nodeModules !== -1) rest = url.slice(nodeModules + '/node_modules/'.length)
  if (rest === null) {
    const asar = url.lastIndexOf('/app.asar/dsh/')
    if (asar !== -1) rest = url.slice(asar + '/app.asar/dsh/'.length)
  }
  if (rest === null) {
    const asar = url.lastIndexOf('/app.asar/')
    if (asar !== -1) rest = url.slice(asar + '/app.asar/'.length)
  }
  if (rest === null) {
    const source = url.lastIndexOf('/.dsh-src/')
    if (source !== -1) rest = url.slice(source + '/.dsh-src/'.length)
  }
  if (rest === null) {
    const slash = url.lastIndexOf('/')
    return slash === -1 ? url : url.slice(slash + 1)
  }

  const parts = rest.split('/').filter((part) => part.length > 0)
  const drop = parts.length > 0 && parts[0].startsWith('@') ? 2 : 1
  const trimmed = parts.slice(drop).join('/')
  return trimmed.length > 0 ? trimmed : null
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
      if (selfSize > 0) {
        const functionName = typeof callFrame.functionName === 'string' && callFrame.functionName.length > 0 ? callFrame.functionName : '(anonymous)'
        const url = typeof callFrame.url === 'string' ? callFrame.url : ''
        const line = Number.isFinite(callFrame.lineNumber) ? callFrame.lineNumber : null
        const siteKey = url + ':' + String(line) + ':' + functionName
        const site = bucket.sites.get(siteKey) ?? { functionName, file: siteFile(url), line, bytes: 0 }
        site.bytes += selfSize
        bucket.sites.set(siteKey, site)
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
    const sites = [...bucket.sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 5)
    result.packages.push({ key: bucket.key, name: bucket.name, kind: bucket.kind, bytes: bucket.bytes, nodes: bucket.nodes, top: sites })
  }
  result.packages.sort((left, right) => right.bytes - left.bytes)
  return result
}

function postMessage(session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params === undefined ? {} : params, (error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

/**
 * Runs one sampling window. Rejects with a readable message when the inspector
 * session cannot be opened, so callers can fall back to structural metrics.
 *
 * The forced collection before `stopSampling` is what separates a real leak from
 * ordinary uncollected garbage: without it every window reports the garbage that
 * happened to be alive when the window closed.
 */
export async function sampleHeap({ durationMs = 20_000, samplingInterval = 4096, forceGc = true } = {}) {
  const session = new Session()
  session.connect()
  const startedAt = Date.now()
  let profile = null
  let failure = null
  let gcApplied = false
  let gcMs = 0
  let gcReclaimedBytes = 0
  try {
    await postMessage(session, 'HeapProfiler.startSampling', { samplingInterval })
    await sleep(durationMs)
    if (forceGc) {
      const beforeGc = memorySnapshot().heapUsed
      const gcStartedAt = Date.now()
      try {
        await postMessage(session, 'HeapProfiler.collectGarbage')
        gcApplied = true
      } catch {
        gcApplied = false
      }
      gcMs = Math.max(0, Date.now() - gcStartedAt)
      gcReclaimedBytes = Math.max(0, beforeGc - memorySnapshot().heapUsed)
    }
    const stopped = await postMessage(session, 'HeapProfiler.stopSampling')
    profile = stopped?.profile ?? null
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
    gcApplied,
    gcMs,
    gcReclaimedBytes,
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