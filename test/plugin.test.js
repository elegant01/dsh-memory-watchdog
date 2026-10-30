import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../lib/index.js'
import { makeTempDir, settle } from './helpers.js'

const IS_WINDOWS = process.platform === 'win32'

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
      return { running: true, pid: 1234, restarts: 0, lastSampleAt: null, lastError: null, lastExit: null }
    },
  }
}

function fakeHandoff() {
  return {
    prepare: async () => ({ ok: true }),
    waitForVerified: async () => ({ status: 'verified' }),
    writeGo: async () => {},
    waitForFrozen: async () => ({ status: 'frozen' }),
    abort: async () => {},
    checkCapability: async () => ({ ok: true, checkedAt: 1 }),
  }
}

function fakeCtx() {
  const routes = new Map()
  const removed = []
  const effects = []
  const handlers = new Map()
  const connection = {
    fetch: {
      register(definition) {
        routes.set(definition.path, definition)
        return () => {
          removed.push(definition.path)
          routes.delete(definition.path)
        }
      },
    },
  }
  const ctx = {
    connection,
    get: () => undefined,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn, label) {
      effects.push({ label, disposer: fn() })
    },
    logger: { warn() {} },
  }
  return { ctx, routes, removed, effects, handlers }
}

function fakeResume(result = null) {
  const scans = []
  return {
    scans,
    enabled: false,
    setEnabled(value) {
      this.enabled = value === true
    },
    state() {
      return { enabled: this.enabled, scanning: false, lastScanAt: null, lastScan: null, ledger: [] }
    },
    scanNow(options) {
      scans.push(options)
      return Promise.resolve(
        result ?? {
          ok: true,
          at: 5,
          code: null,
          error: null,
          resumed: 1,
          candidates: 2,
          deferred: [],
          actions: [{ sessionId: 's1', turn: 4, status: 'prompted' }],
          skipped: [],
        },
      )
    },
  }
}

async function startPlugin(overrides = {}) {
  const temp = await makeTempDir()
  const collector = fakeCollector()
  const rawConfig = { autoRestart: overrides.autoRestart ?? false, resumeAfterCrash: overrides.resumeAfterCrash ?? false }
  const resume = overrides.resume ?? fakeResume()
  const io = fakeCtx()
  const runtime = apply(io.ctx, rawConfig, {
    guardDir: temp.dir,
    collector,
    handoff: fakeHandoff(),
    resume,
    probesDisabled: true,
    capabilityCheck: async () => ({ ok: true, checkedAt: 1 }),
    activity: async () => ({ idle: true, reason: null, checkedAt: 1 }),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  })
  await runtime.starting
  await settle()
  return { ...io, temp, collector, rawConfig, runtime, resume }
}

test('the plugin exports its name, inject list and a default-off volatile switch', () => {
  assert.equal(name, 'dsh-memory-watchdog')
  assert.deepEqual(inject, ['connection'])
  const autoRestart = Config.dict.autoRestart
  assert.equal(autoRestart.meta.default, false)
  assert.equal(autoRestart.meta.volatile, true)
  assert.match(autoRestart.meta.description, /Off by default/)
  assert.match(autoRestart.meta.description, /ENTIRE DSH Desktop/)
  assert.match(autoRestart.meta.description, /discard unsent drafts/)
  assert.match(autoRestart.meta.description, /native quit confirmation is bypassed/)
  assert.match(Config.meta.description, /automatic restart and crash-resume are opt-in/)
  const resume = Config.dict.resumeAfterCrash
  assert.equal(resume.meta.default, false)
  assert.equal(resume.meta.volatile, undefined)
  assert.match(resume.meta.description, /Off by default/)
  assert.match(resume.meta.description, /never resumed/)
  for (const key of ['warningPct', 'criticalPct', 'criticalAvailMb', 'confirmSamples', 'cooldownMinutes', 'restartGatePct', 'residentGrowMb']) {
    assert.equal(Config.dict[key].meta.volatile, true, key)
  }
  assert.equal(Config.dict.warningPct.meta.default, 80)
  assert.equal(Config.dict.criticalPct.meta.default, 90)
  assert.equal(Config.dict.confirmSamples.meta.default, 3)
  assert.equal(Config.dict.cooldownMinutes.meta.default, 30)
  assert.equal(Config.dict.restartGatePct.meta.default, 20)
  assert.equal(Config.dict.residentGrowMb.meta.default, 512)
  assert.match(Config.dict.residentGrowMb.meta.description, /never stops another program/)
})

test('status is served with no-store and a JSON content type', async () => {
  const io = await startPlugin()
  const route = io.routes.get('/api/memory-watchdog.status')
  assert.ok(route)
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.match(response.headers.get('cache-control'), /no-store/)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin.name, 'dsh-memory-watchdog')
  assert.equal(body.autoRestart.enabled, false)
  assert.equal(body.config.resumeAfterCrash, false)
  assert.equal(body.config.thresholds.warningPct, 80)
  assert.equal(body.config.thresholds.restartGatePct, 20)
  assert.equal(body.gate.code, 'gate.unavailable')
  assert.equal(body.attribution.error, 'not-sampled-yet')
  assert.equal(body.system.error, 'not-sampled-yet')
  assert.equal(body.crashes.error, 'not-sampled-yet')
  assert.deepEqual(body.history, [])
  assert.deepEqual(body.residents.alerts, [])
  assert.equal(body.residents.growMb, 512)
  assert.equal(body.residents.tracked, 0)
  assert.equal(body.resume.enabled, false)
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('the events route returns the rolling history and honours the limit', async () => {
  const io = await startPlugin()
  const route = io.routes.get('/api/memory-watchdog.events')
  assert.deepEqual(route.methods, ['GET'])
  const empty = await route.fetch(new Request('http://x/api/memory-watchdog.events'))
  assert.equal(empty.status, 200)
  assert.deepEqual((await empty.json()).items, [])

  for (const at of [1, 2, 3]) {
    await io.runtime.store.recordEvent({ version: 1, kind: 'pressure-warning', at })
  }
  const response = await route.fetch(new Request('http://x/api/memory-watchdog.events?limit=2'))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.limit, 2)
  assert.deepEqual(body.items.map((entry) => entry.at), [2, 3])
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('the resume route refuses to scan while crash resume is off', async () => {
  const io = await startPlugin()
  const route = io.routes.get('/api/memory-watchdog.resume')
  assert.deepEqual(route.methods, ['POST'])
  const request = () => new Request('http://x/api/memory-watchdog.resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })

  const blocked = await route.fetch(request())
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).code, 'resume-disabled')
  assert.equal(io.resume.scans.length, 0)

  const invalid = await route.fetch(new Request('http://x/api/memory-watchdog.resume', { method: 'POST', body: '{}' }))
  assert.equal(invalid.status, 415)

  io.rawConfig.resumeAfterCrash = true
  io.handlers.get('loader/volatile-update')(['resumeAfterCrash'])
  assert.equal(io.resume.enabled, true)
  assert.ok(io.runtime.notices.some((notice) => notice.code === 'settings.resume' && notice.params.enabled === true))

  const scanned = await route.fetch(request())
  assert.equal(scanned.status, 200)
  const body = await scanned.json()
  assert.equal(body.ok, true)
  assert.equal(body.resumed, 1)
  assert.deepEqual(body.actions, [{ sessionId: 's1', turn: 4, status: 'prompted' }])
  assert.equal(io.resume.scans.length, 1)

  io.rawConfig.resumeAfterCrash = false
  io.handlers.get('loader/volatile-update')(['resumeAfterCrash'])
  assert.equal(io.resume.enabled, false)
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('a resume scan failure is reported as a service error', async () => {
  const io = await startPlugin({
    resumeAfterCrash: true,
    resume: {
      enabled: true,
      setEnabled() {},
      state: () => ({ enabled: true, scanning: false, lastScanAt: null, lastScan: null, ledger: [] }),
      scanNow: () => Promise.resolve({
        ok: false,
        at: 1,
        code: 'resume.no-controller',
        error: 'the sessionController service is unavailable',
        resumed: 0,
        candidates: 0,
        deferred: [],
        actions: [],
        skipped: [],
      }),
    },
  })
  const route = io.routes.get('/api/memory-watchdog.resume')
  const response = await route.fetch(new Request('http://x/api/memory-watchdog.resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'resume.no-controller')
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('the cancel route rejects bad media types and bodies', async () => {
  const io = await startPlugin()
  const route = io.routes.get('/api/memory-watchdog.cancel')
  assert.deepEqual(route.methods, ['POST'])

  const unsupported = await route.fetch(new Request('http://x/api/memory-watchdog.cancel', { method: 'POST', body: '{}' }))
  assert.equal(unsupported.status, 415)
  assert.equal((await unsupported.json()).code, 'unsupported-media-type')

  const invalid = await route.fetch(new Request('http://x/api/memory-watchdog.cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid-json')

  const array = await route.fetch(new Request('http://x/api/memory-watchdog.cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]',
  }))
  assert.equal(array.status, 400)
  assert.equal((await array.json()).code, 'invalid-body')

  const empty = await route.fetch(new Request('http://x/api/memory-watchdog.cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '',
  }))
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).code, 'invalid-body')

  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('the cancel route reports idempotent success and a 409 during handoff', async () => {
  const io = await startPlugin()
  const route = io.routes.get('/api/memory-watchdog.cancel')
  const request = () => new Request('http://x/api/memory-watchdog.cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: '{}',
  })

  const first = await route.fetch(request())
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, canceled: false })

  io.runtime.handoffStarted = true
  const second = await route.fetch(request())
  assert.equal(second.status, 409)
  assert.equal((await second.json()).code, 'handoff-in-progress')

  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('volatile config updates reach the runtime and are reported', async () => {
  const io = await startPlugin({ autoRestart: false })
  assert.equal(io.runtime.autoRestartEnabled(), false)
  io.rawConfig.autoRestart = true
  io.handlers.get('loader/volatile-update')(['autoRestart'])
  assert.equal(io.runtime.autoRestartEnabled(), true)
  assert.ok(io.runtime.notices.some((notice) => notice.code === 'settings.autoRestart' && notice.params.enabled === true))
  await settle()

  io.rawConfig.autoRestart = false
  io.handlers.get('loader/volatile-update')([['autoRestart']])
  assert.equal(io.runtime.autoRestartEnabled(), false)
  assert.ok(io.runtime.notices.some((notice) => notice.code === 'settings.autoRestart' && notice.params.enabled === false))
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('volatile threshold updates re-resolve the effective thresholds', async () => {
  const io = await startPlugin()
  assert.equal(io.runtime.thresholds.warningPct, 80)
  io.rawConfig.warningPct = 70
  io.rawConfig.cooldownMinutes = 5
  io.rawConfig.restartGatePct = 0
  io.handlers.get('loader/volatile-update')(['warningPct', 'cooldownMinutes', 'restartGatePct'])
  assert.equal(io.runtime.thresholds.warningPct, 70)
  assert.equal(io.runtime.thresholds.cooldownMs, 5 * 60 * 1000)
  assert.equal(io.runtime.machine.thresholds.warningPct, 70)
  assert.equal(io.runtime.restartGate().code, 'gate.disabled')
  assert.ok(io.runtime.notices.some((notice) => notice.code === 'settings.thresholds'))
  await io.effects[0].disposer()
  await io.temp.cleanup()
})

test('dispose unregisters the routes, stops the collector and detaches the listener', async () => {
  const io = await startPlugin()
  await io.effects[0].disposer()
  assert.equal(io.runtime.disposed, true)
  assert.equal(io.collector.stopped, IS_WINDOWS ? 1 : 0, 'the sampler is only owned on Windows')
  assert.equal(io.runtime.collector === null, !IS_WINDOWS)
  assert.deepEqual(io.removed.sort(), [
    '/api/memory-watchdog.cancel',
    '/api/memory-watchdog.events',
    '/api/memory-watchdog.plugins',
    '/api/memory-watchdog.plugins-export',
    '/api/memory-watchdog.plugins-sample',
    '/api/memory-watchdog.resume',
    '/api/memory-watchdog.snapshot',
    '/api/memory-watchdog.status',
  ])
  assert.equal(io.routes.size, 0)
  assert.equal(io.handlers.has('loader/volatile-update'), false)
  await io.temp.cleanup()
})
