import test from 'node:test'
import assert from 'node:assert/strict'
import { GuardRuntime } from '../lib/runtime.js'
import { COOLDOWN_MS, RESUME_SCAN_DELAYS_MS, STALE_AFTER_MS, STALE_NOTICE_DELAY_MS } from '../lib/constants.js'
import { driveToCritical, driveToWarning, makeClock, makeTempDir, primeNormal, sample, settle, GIB } from './helpers.js'

function fakeCollector() {
  return {
    started: 0,
    stopped: 0,
    start() {
      this.started += 1
    },
    async stop() {
      this.stopped += 1
    },
    state() {
      return {
        running: true,
        pid: 777,
        restarts: 0,
        lastSampleAt: null,
        lastError: null,
        lastExit: null,
        nextRestartInMs: null,
      }
    },
  }
}

function fakeHandoff({ prepareResult = { ok: true }, verified = { status: 'verified' }, frozen = { status: 'frozen' } } = {}) {
  const calls = []
  return {
    calls,
    prepare: async (options) => {
      calls.push({ type: 'prepare', options })
      return prepareResult
    },
    waitForVerified: async () => {
      calls.push({ type: 'waitForVerified' })
      return verified
    },
    writeGo: async () => {
      calls.push({ type: 'writeGo' })
    },
    waitForFrozen: async () => {
      calls.push({ type: 'waitForFrozen' })
      return frozen
    },
    abort: async (reason) => {
      calls.push({ type: 'abort', reason })
    },
    checkCapability: async () => ({ ok: true }),
  }
}

async function harness(options = {}) {
  const temp = await makeTempDir()
  const clock = makeClock()
  const intervalRecords = []
  const timeoutRecords = []
  const activity = { current: { idle: true, reason: null } }
  const handoff = fakeHandoff(options.handoff)
  const collector = fakeCollector()
  const rawConfig = { autoRestart: options.autoRestart ?? true }
  if (options.restartGatePct !== undefined) rawConfig.restartGatePct = options.restartGatePct
  if (options.resumeAfterCrash !== undefined) rawConfig.resumeAfterCrash = options.resumeAfterCrash
  const attributionProbe =
    options.attribution === null
      ? async () => ({ ok: false, at: clock.now, error: 'probe failed', sharePct: null, dshBytes: null, top: [] })
      : typeof options.attribution === 'function'
        ? options.attribution
        : async () => ({
            ok: true,
            at: clock.now,
            sampledAt: clock.now,
            error: null,
            systemCommitUsed: 40 * GIB,
            dshBytes: 30 * GIB,
            dshCount: 4,
            sharePct: options.sharePct ?? 75,
            top: [{ pid: 1, parentPid: null, name: 'DeepSeek Harness.exe', bytes: 20 * GIB, dsh: true }],
          })
  const processRef = {
    pid: 4242,
    connected: true,
    disconnects: 0,
    disconnect() {
      this.disconnects += 1
      this.connected = false
    },
    memoryUsage() {
      return { rss: 128 * 1024 * 1024 }
    },
  }
  const deps = {
    guardDir: temp.dir,
    collector,
    handoff,
    store: undefined,
    capabilityCheck: async () => options.capability ?? { ok: true, checkedAt: clock.now },
    activity: async () => ({ ...activity.current, checkedAt: clock.now }),
    setInterval: (fn, ms) => {
      const record = { fn, ms, cleared: false }
      intervalRecords.push(record)
      return record
    },
    clearInterval: (record) => {
      record.cleared = true
    },
    setTimeout: (fn, ms) => {
      const record = { fn, ms, cleared: false }
      timeoutRecords.push(record)
      return record
    },
    clearTimeout: (record) => {
      record.cleared = true
    },
    attributionProbe,
    systemProbe:
      options.systemProbe ??
      (async () => ({
        ok: true,
        at: clock.now,
        error: null,
        systemDrive: 'C:',
        automaticManaged: false,
        commitUsed: 30 * GIB,
        commitLimit: 44 * GIB,
        physicalTotal: 32 * GIB,
        physicalAvailable: 8 * GIB,
        pagefileTotalBytes: 10 * GIB,
        usedPct: 68.2,
        pagefiles: [{ path: 'D:\\pagefile.sys', currentMb: 10000, initialMb: null, maximumMb: null, exists: true, systemVolume: false }],
        advice: [{ code: 'pagefile.ok', severity: 'ok', suggestionMb: null, pagefileMb: 10000, headroomMb: 12288 }],
      })),
    crashProbe:
      options.crashProbe ??
      (async () => ({
        ok: true,
        at: clock.now,
        error: null,
        days: 7,
        limit: 20,
        logDir: 'logs',
        items: [],
        crashCount: 0,
        eventCount: 0,
      })),
    sessionController: options.sessionController,
    resume: options.resume,
  }
  const rt = new GuardRuntime({
    ctx: { get: () => undefined },
    rawConfig,
    deps,
    now: () => clock.now,
    supported: options.supported ?? true,
    platform: options.platform ?? 'win32',
    arch: options.arch ?? 'x64',
    processRef,
    sessionId: 'test-session',
    version: '0.1.0',
  })
  await rt.start()
  await settle()
  await settle()

  async function feed(pct, { advance = 5000, limit } = {}) {
    clock.advance(advance)
    rt.onSample(sample(pct, clock.now, limit === undefined ? undefined : { limit }))
    await settle()
    await settle()
  }

  async function tickAfter(ms = 1000) {
    clock.advance(ms)
    await rt.tick()
    await settle()
  }

  async function cleanup() {
    await rt.dispose()
    await temp.cleanup()
  }

  return {
    rt,
    clock,
    handoff,
    collector,
    processRef,
    rawConfig,
    activity,
    intervalRecords,
    timeoutRecords,
    feed,
    tickAfter,
    cleanup,
  }
}

test('warning never arms automatic restart', async () => {
  const h = await harness()
  await driveToWarning(h.feed)
  assert.equal(h.rt.machine.state, 'warning')
  await h.tickAfter()
  assert.equal(h.rt.pending, null)
  assert.equal(h.handoff.calls.length, 0)
  const status = h.rt.status()
  assert.equal(status.pressure.state, 'warning')
  assert.equal(status.action.state, 'observing')
  await h.cleanup()
})

test('critical waits for three idle checks and a grace period, then hands off', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  assert.equal(h.rt.machine.state, 'critical')
  assert.equal(h.rt.pending.phase, 'waiting')
  assert.equal(h.rt.status().action.state, 'waiting')

  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'confirming')
  assert.equal(h.handoff.calls.length, 0)

  await h.tickAfter(1000)
  assert.equal(h.handoff.calls.length, 0)
  await h.tickAfter(1000)

  assert.equal(h.handoff.calls.filter((call) => call.type === 'prepare').length, 1)
  assert.equal(h.handoff.calls.filter((call) => call.type === 'writeGo').length, 1)
  assert.equal(h.handoff.calls.filter((call) => call.type === 'waitForFrozen').length, 1)
  assert.equal(h.rt.handoffStarted, true)
  assert.ok(h.rt.cooldownUntil > h.clock.now)
  assert.equal(h.rt.attemptedEpisodeId, h.rt.machine.episodeId)
  assert.equal(h.rt.status().action.state, 'handoff')
  assert.equal(h.rt.status().action.cancelable, false)
  assert.equal(h.timeoutRecords.length, 1)
  h.timeoutRecords[0].fn()
  assert.equal(h.processRef.disconnects, 1)
  await h.cleanup()
})

test('busy activity holds the pending restart and reminds after five minutes', async () => {
  const h = await harness()
  h.activity.current = { idle: false, reason: 'agent-running' }
  await driveToCritical(h.feed)
  assert.equal(h.rt.pending.phase, 'waiting')

  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'waiting')
  assert.equal(h.rt.pending.idleStreak, 0)
  assert.equal(h.handoff.calls.length, 0)
  assert.ok(h.rt.notices.some((notice) => notice.code === 'action.waiting'))

  const before = h.rt.notices.filter((notice) => notice.code === 'action.waitingReminder').length
  for (let i = 0; i < 61; i += 1) await h.feed(96)
  const after = h.rt.notices.filter((notice) => notice.code === 'action.waitingReminder').length
  assert.equal(after, before + 1)
  assert.equal(h.rt.pending.phase, 'waiting')
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('recovering to normal cancels the pending restart', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  assert.notEqual(h.rt.pending, null)

  await h.feed(70)
  await h.feed(70)
  await h.feed(70)
  assert.equal(h.rt.machine.state, 'warning')
  assert.equal(h.rt.pending, null)
  assert.ok(h.rt.notices.some((notice) => notice.code === 'action.canceled.recovered'))

  await h.feed(70)
  await h.feed(70)
  await h.feed(70)
  assert.equal(h.rt.machine.state, 'normal')
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('the user can cancel the pending action, and cancel is idempotent', async () => {
  const h = await harness()
  await driveToCritical(h.feed)

  const first = await h.rt.cancel()
  assert.deepEqual(first, { ok: true, canceled: true })
  assert.equal(h.rt.pending, null)
  assert.equal(h.rt.canceledEpisodeId, h.rt.machine.episodeId)
  assert.ok(h.rt.notices.some((notice) => notice.code === 'action.canceled.user'))

  const second = await h.rt.cancel()
  assert.deepEqual(second, { ok: true, canceled: false })

  await h.tickAfter()
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('a new task during the grace period cancels confirmation and returns to waiting', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'confirming')

  h.activity.current = { idle: false, reason: 'agent-queued' }
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'waiting')
  assert.equal(h.rt.pending.graceUntil, 0)
  assert.ok(h.rt.notices.some((notice) => notice.code === 'action.confirmationCanceled'))
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('automatic restart off never arms and turning it off cancels pending work', async () => {
  const off = await harness({ autoRestart: false })
  await driveToCritical(off.feed)
  assert.equal(off.rt.machine.state, 'critical')
  assert.equal(off.rt.pending, null)
  assert.equal(off.handoff.calls.length, 0)
  assert.equal(off.rt.status().autoRestart.enabled, false)
  await off.cleanup()

  const on = await harness({ autoRestart: true })
  await driveToCritical(on.feed)
  assert.notEqual(on.rt.pending, null)
  on.rawConfig.autoRestart = false
  on.rt.onConfigUpdate(['autoRestart'])
  assert.equal(on.rt.pending, null)
  assert.ok(on.rt.notices.some((notice) => notice.code === 'action.canceled.disabled'))
  assert.ok(on.rt.notices.some((notice) => notice.code === 'settings.autoRestart' && notice.params.enabled === false))
  await on.cleanup()
})

test('an unavailable helper capability blocks arming and is reported', async () => {
  const h = await harness({ capability: { ok: false, reason: 'helper is inside a job', checkedAt: 1 } })
  assert.equal(h.rt.capability.state, 'unavailable')
  assert.ok(h.rt.notices.some((notice) => notice.code === 'capability.unavailable'))
  await driveToCritical(h.feed)
  assert.equal(h.rt.machine.state, 'critical')
  assert.equal(h.rt.pending, null)
  assert.equal(h.handoff.calls.length, 0)
  assert.equal(h.rt.status().autoRestart.capability.ok, false)
  await h.cleanup()
})

test('a failed handoff sets a 30-minute cooldown and never retries the same episode', async () => {
  const h = await harness({ handoff: { prepareResult: { ok: false, reason: 'inspect: Host identity mismatch' } } })
  await driveToCritical(h.feed)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)

  assert.equal(h.handoff.calls.filter((call) => call.type === 'prepare').length, 1)
  assert.ok(h.rt.notices.some((notice) => notice.code === 'restart.failed'))
  assert.equal(h.rt.status().action.state, 'cooldown')
  assert.ok(h.rt.status().cooldown.active)
  const cooldownRemaining = h.rt.cooldownUntil - h.clock.now
  assert.ok(cooldownRemaining > COOLDOWN_MS - 10_000)
  assert.equal(h.rt.attemptedEpisodeId, h.rt.machine.episodeId)

  await h.feed(96)
  await h.tickAfter(1000)
  assert.equal(h.handoff.calls.filter((call) => call.type === 'prepare').length, 1)

  h.clock.advance(COOLDOWN_MS + 60_000)
  await h.tickAfter(1000)
  assert.equal(h.handoff.calls.filter((call) => call.type === 'prepare').length, 1)

  await h.feed(70)
  await h.feed(70)
  await h.feed(70)
  assert.equal(h.rt.machine.state, 'normal')
  await driveToCritical(h.feed)
  assert.equal(h.rt.machine.state, 'critical')
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'waiting')
  await h.cleanup()
})

test('a stale sample drops to unknown, cancels pending work and never restarts', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  assert.notEqual(h.rt.pending, null)

  h.clock.advance(STALE_AFTER_MS + 1000)
  await h.rt.tick()
  await settle()

  assert.equal(h.rt.machine.state, 'unknown')
  assert.equal(h.rt.pending, null)
  assert.equal(h.rt.notices.some((notice) => notice.code === 'pressure.unknown'), false, 'the stale notice is deferred, not immediate')
  const blip = h.timeoutRecords.find((record) => record.ms === STALE_NOTICE_DELAY_MS)
  assert.ok(blip, 'a deferred stale notice must be armed')
  blip.fn()
  assert.ok(h.rt.notices.some((notice) => notice.code === 'pressure.unknown'))
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('a short sample delay that recovers in time is counted but never toasted', async () => {
  const h = await harness()
  await primeNormal(h.feed)
  const noticesBefore = h.rt.notices.length

  h.clock.advance(STALE_AFTER_MS + 1000)
  await h.rt.tick()
  await settle()
  assert.equal(h.rt.machine.state, 'unknown')

  for (let index = 0; index < 3; index += 1) await h.feed(70)
  assert.equal(h.rt.machine.state, 'normal')
  assert.equal(h.rt.notices.length, noticesBefore, 'neither the blip nor its recovery may toast')
  assert.equal(h.rt.staleBlips, 1)
  const blip = h.timeoutRecords.find((record) => record.ms === STALE_NOTICE_DELAY_MS)
  assert.equal(blip.cleared, true)
  await h.cleanup()
})

test('unsupported platforms keep monitoring off and never arm', async () => {
  const temp = await makeTempDir()
  const clock = makeClock()
  const collector = fakeCollector()
  const handoff = fakeHandoff()
  const deps = {
    guardDir: temp.dir,
    collector,
    handoff,
    capabilityCheck: async () => ({ ok: false, reason: 'unsupported' }),
    activity: async () => ({ idle: true, reason: null, checkedAt: clock.now }),
    setInterval: () => ({ cleared: false }),
    clearInterval: () => {},
    setTimeout: () => ({ cleared: false }),
    clearTimeout: () => {},
  }
  const rt = new GuardRuntime({
    ctx: { get: () => undefined },
    rawConfig: { autoRestart: true },
    deps,
    now: () => clock.now,
    supported: false,
    platform: 'linux',
    arch: 'x64',
    processRef: { pid: 1, memoryUsage: () => ({ rss: 1 }) },
    sessionId: 'unsupported',
  })
  await rt.start()
  await settle()
  assert.equal(collector.started, 0)
  const feed = async (pct) => {
    clock.advance(5000)
    rt.onSample(sample(pct, clock.now))
    await settle()
    await settle()
  }
  await driveToCritical(feed)
  assert.equal(rt.machine.state, 'critical')
  await rt.tick()
  assert.equal(rt.pending, null)
  assert.equal(handoff.calls.length, 0)
  const status = rt.status()
  assert.equal(status.platform.supported, false)
  assert.equal(status.platform.platform, 'linux')
  assert.equal(status.collector.running, false)
  await rt.dispose()
  await temp.cleanup()
})

test('status exposes the documented fields and reports notices and errors', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  await h.tickAfter(1000)
  const status = h.rt.status()

  assert.equal(status.ok, true)
  assert.equal(status.plugin.name, 'dsh-memory-watchdog')
  assert.equal(status.plugin.hostPid, 4242)
  assert.equal(status.plugin.hostRss, 128 * 1024 * 1024)
  assert.equal(status.autoRestart.enabled, true)
  assert.equal(status.autoRestart.capability.ok, true)
  assert.equal(status.pressure.state, 'critical')
  assert.equal(typeof status.pressure.pct, 'number')
  assert.equal(typeof status.pressure.availableCommit, 'number')
  assert.equal(status.pressure.stale, false)
  assert.equal(status.action.state, 'waiting')
  assert.equal(status.action.cancelable, true)
  assert.equal(status.activity.idle, true)
  assert.equal(status.collector.pid, 777)
  assert.ok(Array.isArray(status.notices))
  assert.equal(status.episode.attempted, false)
  assert.equal(status.handoff.started, false)

  h.rt.onCollectorError({ kind: 'malformed', message: 'bad line' })
  h.rt.onCollectorError({ kind: 'malformed', message: 'bad line again' })
  const malformedNotices = h.rt.notices.filter((notice) => notice.code === 'collector.malformed')
  assert.equal(malformedNotices.length, 1)
  assert.match(h.rt.status().lastError.message, /malformed/)
  await h.cleanup()
})

test('dispose clears timers, stops the collector and ignores further samples', async () => {
  const h = await harness()
  assert.equal(h.collector.started, 1)
  const tickRecord = h.intervalRecords[0]
  await h.rt.dispose()
  assert.equal(tickRecord.cleared, true)
  assert.equal(h.collector.stopped, 1)

  h.rt.onSample(sample(96, h.clock.now))
  assert.equal(h.rt.lastSample, null)
  await h.rt.dispose()
  assert.equal(h.collector.stopped, 1)
  await h.cleanup()
})

test('enabling auto restart runs a fresh capability check when needed', async () => {
  const h = await harness({ autoRestart: false, capability: { ok: false, reason: 'not checked', checkedAt: 1 } })
  assert.equal(h.rt.capability.ok, false)
  h.rawConfig.autoRestart = true
  h.rt.onConfigUpdate(['autoRestart'])
  await settle()
  await settle()
  assert.ok(h.rt.notices.some((notice) => notice.code === 'settings.autoRestart' && notice.params.enabled === true))
  await h.cleanup()
})

test('the restart gate holds back when DSH is not the main committer', async () => {
  const h = await harness({ sharePct: 5 })
  await driveToCritical(h.feed)
  assert.equal(h.rt.machine.state, 'critical')
  assert.equal(h.rt.pending, null)
  const status = h.rt.status()
  assert.equal(status.gate.allowed, false)
  assert.equal(status.gate.code, 'gate.share-below')
  assert.equal(status.action.state, 'observing')
  assert.ok(h.rt.notices.some((notice) => notice.code === 'action.skipped.external'))
  assert.equal(h.rt.attemptedEpisodeId, h.rt.machine.episodeId)
  assert.equal(h.handoff.calls.length, 0)
  await h.cleanup()
})

test('the restart gate fails closed while attribution is unavailable', async () => {
  const h = await harness({ attribution: null })
  await driveToCritical(h.feed)
  assert.equal(h.rt.pending, null)
  assert.equal(h.rt.status().gate.code, 'gate.unavailable')
  assert.equal(h.rt.status().attribution.ok, false)
  await h.cleanup()
})

test('a gate of zero percent restarts even without attribution', async () => {
  const h = await harness({ attribution: null, restartGatePct: 0 })
  await driveToCritical(h.feed)
  assert.equal(h.rt.status().gate.code, 'gate.disabled')
  assert.equal(h.rt.pending.phase, 'waiting')
  await h.cleanup()
})

test('a gate that closes during confirmation aborts the handoff', async () => {
  const h = await harness()
  await driveToCritical(h.feed)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  assert.equal(h.rt.pending.phase, 'confirming')
  h.rt.attribution = {
    ok: true,
    at: h.clock.now,
    error: null,
    systemCommitUsed: 40 * GIB,
    dshBytes: GIB,
    dshCount: 1,
    sharePct: 2.5,
    top: [],
  }
  await h.tickAfter(1000)
  await h.tickAfter(1000)
  const aborts = h.handoff.calls.filter((call) => call.type === 'abort')
  assert.equal(aborts.length, 1)
  assert.equal(aborts[0].reason, 'restart gate blocked: gate.share-below')
  assert.equal(h.handoff.calls.filter((call) => call.type === 'writeGo').length, 0)
  assert.equal(h.rt.pending, null)
  assert.ok(
    h.rt.notices.some(
      (notice) => notice.code === 'action.canceled.recovered' && /gate/.test(String(notice.params.reason ?? '')),
    ),
  )
  await h.cleanup()
})

test('status exposes attribution, pagefile advice and the crash timeline', async () => {
  const h = await harness()
  assert.equal(h.rt.attribution.ok, true)
  await h.tickAfter(1000)
  const status = h.rt.status()
  assert.equal(status.attribution.ok, true)
  assert.equal(status.attribution.sharePct, 75)
  assert.equal(status.attribution.top[0].name, 'DeepSeek Harness.exe')
  assert.equal(status.gate.code, 'gate.passed')
  assert.equal(status.system.pagefiles[0].path, 'D:\\pagefile.sys')
  assert.deepEqual(status.system.advice.map((entry) => entry.code), ['pagefile.ok'])
  assert.equal(status.crashes.ok, true)
  assert.deepEqual(status.crashes.items, [])
  await h.cleanup()
})

test('crash resume scans are scheduled after startup and follow the deferred deadline', async () => {
  let handle = null
  const scans = []
  const resume = {
    enabled: false,
    setEnabled(value) {
      this.enabled = value === true
    },
    state() {
      return { enabled: this.enabled, scanning: false, lastScanAt: null, lastScan: null, ledger: [] }
    },
    scanNow() {
      scans.push(1)
      const deferred = scans.length === 1
      return Promise.resolve({
        ok: true,
        at: handle.clock.now,
        code: null,
        error: null,
        resumed: deferred ? 0 : 1,
        candidates: 1,
        deferred: deferred ? [{ sessionId: 's1', dueAt: handle.clock.now + 30000 }] : [],
        nextDueAt: deferred ? handle.clock.now + 30000 : null,
        actions: [],
        skipped: [],
      })
    },
  }
  handle = await harness({ resumeAfterCrash: true, resume })
  assert.equal(resume.enabled, true)
  const first = handle.timeoutRecords.find((record) => record.ms === RESUME_SCAN_DELAYS_MS[0])
  assert.ok(first, 'a startup resume scan is scheduled')

  first.fn()
  await settle()
  await settle()
  assert.equal(scans.length, 1)
  const rearmed = handle.timeoutRecords[handle.timeoutRecords.length - 1]
  assert.equal(rearmed.cleared, false)
  assert.equal(rearmed.ms, 30000)

  rearmed.fn()
  await settle()
  await settle()
  assert.equal(scans.length, 2)
  const nextRound = handle.timeoutRecords[handle.timeoutRecords.length - 1]
  assert.equal(nextRound.ms, RESUME_SCAN_DELAYS_MS[1] - RESUME_SCAN_DELAYS_MS[0])

  handle.rawConfig.resumeAfterCrash = false
  handle.rt.onConfigUpdate(['resumeAfterCrash'])
  assert.equal(resume.enabled, false)
  assert.equal(nextRound.cleared, true)
  assert.ok(handle.rt.notices.some((notice) => notice.code === 'settings.resume' && notice.params.enabled === false))
  await handle.cleanup()
})

test('a resume scan is not scheduled while crash resume is off', async () => {
  const h = await harness()
  assert.equal(h.rt.resumeEnabled(), false)
  assert.equal(h.timeoutRecords.length, 0)
  assert.equal(h.rt.status().resume.enabled, false)
  await h.cleanup()
})

test('a resident process that keeps growing is named and rate limited', async () => {
  const MIB = 1024 * 1024
  const series = [2048, 3072, 3072, 5000]
  let calls = 0
  const h = await harness({
    autoRestart: false,
    attribution: async () => {
      const mb = series[Math.min(calls, series.length - 1)]
      calls += 1
      return {
        ok: true,
        ts: 1,
        systemCommitUsed: 40 * GIB,
        dsh: { bytes: 2 * GIB, count: 3 },
        top: [{ pid: 7, parentPid: 1, name: 'node.exe', bytes: mb * MIB, dsh: false, exePath: 'E:\\nodejs\\node.exe', ageMin: 40 }],
      }
    },
  })
  assert.equal(h.rt.residentAlerts.length, 0)
  assert.equal(h.rt.residentTracked[7].baseBytes, 2048 * MIB)

  await h.tickAfter(6 * 60 * 1000)
  await settle()
  assert.equal(calls, 2)
  assert.equal(h.rt.residentAlerts.length, 1)
  const alert = h.rt.residentAlerts[0]
  assert.equal(alert.name, 'node.exe')
  assert.equal(alert.growthBytes, 1024 * MIB)
  assert.equal(alert.exePath, 'E:\\nodejs\\node.exe')
  assert.equal(h.rt.notices.filter((notice) => notice.code === 'attribution.resident-growing').length, 1)

  await h.tickAfter(6 * 60 * 1000)
  await settle()
  assert.equal(h.rt.residentAlerts.length, 1, 'no growth means no new alert')

  await h.tickAfter(31 * 60 * 1000)
  await settle()
  assert.equal(h.rt.residentAlerts.length, 2)
  const status = h.rt.status()
  assert.equal(status.residents.tracked, 1)
  assert.equal(status.residents.growMb, 512)
  assert.equal(status.residents.alerts.length, 2)
  assert.equal(status.residents.alerts[1].name, 'node.exe')
  await h.cleanup()
})

test('the growth threshold can be lowered from settings and reaches the runtime', async () => {
  const h = await harness({ autoRestart: false })
  assert.equal(h.rt.thresholds.residentGrowMb, 512)
  h.rawConfig.residentGrowMb = 128
  h.rt.onConfigUpdate(['residentGrowMb'])
  assert.equal(h.rt.thresholds.residentGrowMb, 128)
  assert.equal(h.rt.thresholds.residentGrowBytes, 128 * 1024 * 1024)
  await h.cleanup()
})
