import { EventEmitter } from 'node:events'
import { packageFromUrl } from './heap-sampler.js'
import { scriptPath } from './plugin-inventory.js'

const MAX_DEBUG_SAMPLES = 5

/**
 * Approximate wall-clock time the host process started, derived from
 * `process.uptime()`. It is only used to express "this plugin registered N
 * seconds after the host booted", so a rounding error of a few milliseconds
 * does not matter. Returns null when uptime is unavailable.
 */
export function hostBootAt(now = Date.now()) {
  const uptime = typeof process.uptime === 'function' ? process.uptime() : null
  if (typeof uptime !== 'number' || !Number.isFinite(uptime) || uptime < 0) return null
  return Math.round(now - uptime * 1000)
}

function withSlash(directory) {
  if (typeof directory !== 'string') return null
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.length === 0 ? null : normalized + '/'
}

function framesFromStack(stack) {
  if (typeof stack !== 'string') return []
  const frames = []
  for (const rawLine of stack.split('\n').slice(1)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const match = /([^\s()]+):\d+:\d+\)?$/.exec(line)
    if (match === null) continue
    const url = match[1]
    frames.push({ url, path: scriptPath(url), parsed: packageFromUrl(url) })
  }
  return frames
}

/** Picks the direct caller frame; anything routed through node internals is not plugin code. */
export function packageFromStack(stack, { ownPackage = null } = {}) {
  const frames = framesFromStack(stack)
  let index = 0
  while (index < frames.length && ownPackage !== null && frames[index].parsed?.key === ownPackage) index += 1
  const candidate = index < frames.length ? frames[index] : null
  if (candidate === null || candidate.parsed === null) return null
  // Registrations issued through a node:internal API (console streams, process
  // hooks, stream internals) are runtime noise, not plugin behaviour.
  if (candidate.parsed.kind === 'builtin') return null
  return candidate.parsed
}

function ownerForPath(path, ownerDirs) {
  if (path === null || ownerDirs.length === 0) return null
  let best = null
  for (const owner of ownerDirs) {
    if (owner.path === null) continue
    if (path === owner.path.slice(0, -1) || path.startsWith(owner.path)) {
      if (best === null || owner.path.length > best.path.length) best = owner
    }
  }
  return best
}

/**
 * Attributes a registration stack to an installed plugin. Installed plugin
 * directories win; frames belonging to framework code (host, cordis, node
 * internals) are skipped so a plugin is credited for the call it made, not for
 * the machinery it called through.
 */
export function attributeStack(stack, { ownPackage = null, ownDir = null, ownerDirs = [] } = {}) {
  const frames = framesFromStack(stack)
  const ownPath = withSlash(ownDir)
  const owners = ownerDirs.filter((owner) => owner !== null && typeof owner === 'object')
  let fallback = null
  let sawFrame = null
  for (const frame of frames) {
    if (frame.path === null && frame.parsed === null) continue
    if (ownPath !== null && frame.path !== null && frame.path.startsWith(ownPath)) continue
    if (sawFrame === null) sawFrame = frame.path
    const owner = ownerForPath(frame.path, owners)
    if (owner !== null) return { owner, matched: 'directory' }
    if (frame.parsed === null) continue
    if (frame.parsed.kind === 'builtin') continue
    if (frame.parsed.kind === 'local' || frame.parsed.kind === 'source') continue
    if (ownPackage !== null && frame.parsed.key === ownPackage) continue
    if (fallback === null) fallback = frame.parsed
  }
  if (fallback !== null) return { owner: fallback, matched: 'url' }
  return { owner: null, matched: 'none', sample: sawFrame }
}

function captureOwner(options, debug) {
  try {
    const error = new Error()
    if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(error, captureOwner)
    const result = attributeStack(error.stack, options)
    if (result.owner === null) {
      debug.unattributed += 1
      if (result.sample !== undefined && result.sample !== null && debug.samples.length < MAX_DEBUG_SAMPLES) {
        if (!debug.samples.includes(result.sample)) debug.samples.push(result.sample)
      }
      return null
    }
    debug.attributed += 1
    if (result.matched === 'url') debug.byUrl += 1
    return result.owner
  } catch {
    return null
  }
}

/**
 * Structural plugin radar. It never touches heap contents: it only counts
 * long-lived timers and event listeners, attributed by the registration stack.
 * Every patch is reversible through uninstall().
 */
export function createPluginRadar({ now = Date.now, ownPackage = null, ownDir = null, ownerDirs = [], bootAt = null } = {}) {
  const counts = new Map()
  const timerOwners = new WeakMap()
  const listenerOwners = new WeakMap()
  let installedAt = null
  let state = null
  let installed = false
  // Tests need a fixed boot time; production derives it from process.uptime().
  const bootOverride = typeof bootAt === 'number' && Number.isFinite(bootAt) ? bootAt : null
  let options = { ownPackage, ownDir: withSlash(ownDir), ownerDirs }
  let debug = { attributed: 0, unattributed: 0, byUrl: 0, samples: [] }

  function setOwners(next = {}) {
    options = {
      ownPackage: next.ownPackage === undefined ? options.ownPackage : next.ownPackage,
      ownDir: withSlash(next.ownDir === undefined ? options.ownDir : next.ownDir),
      ownerDirs: Array.isArray(next.ownerDirs) ? next.ownerDirs : options.ownerDirs,
    }
    return options
  }

  function ensure(key, name, kind) {
    const existing = counts.get(key)
    if (existing !== undefined) return existing
    const created = {
      key,
      name,
      kind,
      timers: 0,
      listeners: 0,
      lastAt: 0,
      timerPeak: 0,
      listenerPeak: 0,
      // First time this package was seen registering anything. It is a lower
      // bound on how late the package showed up, not its real load cost: a
      // plugin that loaded in 200 ms but only registers its first timer a
      // second later looks like "1 s later" here.
      firstSeenAt: now(),
    }
    counts.set(key, created)
    return created
  }

  function bump(owner, field, delta) {
    if (owner === null) return
    const entry = ensure(owner.key, owner.name, owner.kind)
    entry[field] = Math.max(0, entry[field] + delta)
    entry.lastAt = now()
    if (field === 'timers' && entry.timers > entry.timerPeak) entry.timerPeak = entry.timers
    if (field === 'listeners' && entry.listeners > entry.listenerPeak) entry.listenerPeak = entry.listeners
  }

  function install() {
    if (installed) return false
    const globals = globalThis
    const proto = EventEmitter.prototype
    const originals = {
      setInterval: globals.setInterval,
      clearInterval: globals.clearInterval,
      on: proto.on,
      addListener: proto.addListener,
      removeListener: proto.removeListener,
      off: proto.off,
      removeAllListeners: proto.removeAllListeners,
    }
    if (typeof originals.setInterval !== 'function' || typeof originals.on !== 'function') return false

    function setIntervalWrapped(callback, delay, ...rest) {
      const handle = originals.setInterval.call(globals, callback, delay, ...rest)
      try {
        const owner = captureOwner(options, debug)
        if (owner !== null && handle !== null && (typeof handle === 'object' || typeof handle === 'function')) {
          timerOwners.set(handle, owner)
          bump(owner, 'timers', 1)
        }
      } catch {}
      return handle
    }

    function clearIntervalWrapped(handle) {
      let result
      try {
        result = originals.clearInterval.call(globals, handle)
      } finally {
        try {
          const owner = handle === null || handle === undefined ? undefined : timerOwners.get(handle)
          if (owner !== undefined) {
            timerOwners.delete(handle)
            bump(owner, 'timers', -1)
          }
        } catch {}
      }
      return result
    }

    function addWrapped(type, listener, ...rest) {
      let result
      try {
        result = originals.on.call(this, type, listener, ...rest)
      } finally {
        try {
          if (typeof listener === 'function') {
            let byEvent = listenerOwners.get(this)
            if (byEvent === undefined) {
              byEvent = new Map()
              listenerOwners.set(this, byEvent)
            }
            let byListener = byEvent.get(type)
            if (byListener === undefined) {
              byListener = new Map()
              byEvent.set(type, byListener)
            }
            if (!byListener.has(listener)) {
              const owner = captureOwner(options, debug)
              if (owner !== null) {
                byListener.set(listener, owner)
                bump(owner, 'listeners', 1)
              }
            }
          }
        } catch {}
      }
      return result
    }

    function removeWrapped(type, listener, ...rest) {
      let result
      try {
        result = originals.removeListener.call(this, type, listener, ...rest)
      } finally {
        try {
          if (typeof listener === 'function') {
            const byEvent = listenerOwners.get(this)
            const byListener = byEvent === undefined ? undefined : byEvent.get(type)
            const owner = byListener === undefined ? undefined : byListener.get(listener)
            if (owner !== undefined) {
              byListener.delete(listener)
              bump(owner, 'listeners', -1)
            }
          }
        } catch {}
      }
      return result
    }

    function removeAllWrapped(type) {
      let result
      try {
        result = originals.removeAllListeners.call(this, type)
      } finally {
        try {
          const byEvent = listenerOwners.get(this)
          if (byEvent !== undefined) {
            for (const [eventType, byListener] of byEvent) {
              if (type !== undefined && eventType !== type) continue
              for (const owner of byListener.values()) bump(owner, 'listeners', -1)
              byListener.clear()
            }
            if (type !== undefined) byEvent.delete(type)
            else listenerOwners.delete(this)
          }
        } catch {}
      }
      return result
    }

    globals.setInterval = setIntervalWrapped
    globals.clearInterval = clearIntervalWrapped
    proto.on = addWrapped
    proto.addListener = addWrapped
    proto.removeListener = removeWrapped
    if (typeof originals.off === 'function') proto.off = removeWrapped
    proto.removeAllListeners = removeAllWrapped

    state = { originals, globals, proto }
    installed = true
    installedAt = now()
    return true
  }

  function uninstall() {
    if (!installed || state === null) return false
    try {
      state.globals.setInterval = state.originals.setInterval
      state.globals.clearInterval = state.originals.clearInterval
      state.proto.on = state.originals.on
      state.proto.addListener = state.originals.addListener
      state.proto.removeListener = state.originals.removeListener
      state.proto.off = state.originals.off
      state.proto.removeAllListeners = state.originals.removeAllListeners
    } catch {}
    installed = false
    state = null
    return true
  }

  function snapshot() {
    const at = now()
    const bootedAt = bootOverride ?? hostBootAt(at)
    const packages = [...counts.values()]
      .map((entry) => {
        const firstSeenAt = typeof entry.firstSeenAt === 'number' && entry.firstSeenAt > 0 ? entry.firstSeenAt : null
        return {
          ...entry,
          firstSeenAt,
          // Milliseconds between host boot and the first registration seen for
          // this package. Null when the boot time cannot be derived.
          firstSeenMs: firstSeenAt === null || bootedAt === null ? null : Math.max(0, firstSeenAt - bootedAt),
        }
      })
      .sort((left, right) => right.timers + right.listeners - (left.timers + left.listeners))
    let timers = 0
    let listeners = 0
    for (const entry of packages) {
      timers += entry.timers
      listeners += entry.listeners
    }
    return {
      enabled: installed,
      since: installedAt,
      bootAt: bootedAt,
      uptimeMs: bootedAt === null ? null : Math.max(0, at - bootedAt),
      packages,
      totals: { timers, listeners },
      owners: options.ownerDirs.length,
      debug: { attributed: debug.attributed, unattributed: debug.unattributed, byUrl: debug.byUrl, samples: [...debug.samples] },
    }
  }

  function reset() {
    counts.clear()
    debug = { attributed: 0, unattributed: 0, byUrl: 0, samples: [] }
    return true
  }

  return {
    install,
    uninstall,
    setOwners,
    snapshot,
    reset,
    get installed() {
      return installed
    },
  }
}