import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = fileURLToPath(new URL('../lib/client/index.js', import.meta.url))
const clientSource = readFileSync(clientPath, 'utf8')

function loadClient(options = {}) {
  let definition = null
  const status = options.status ?? { ok: true }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanup();
      } catch {}
    },
    useRef: (initial) => ({ current: initial }),
  }
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, options: opts })
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith('.events') ? { ok: true, items: [] } : status),
        text: async () => JSON.stringify(status),
      }
    },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    setTimeout: (fn) => {
      const timer = { unref() {} }
      void timer
      return { unref() {}, cancel: fn }
    },
    clearTimeout: () => {},
    console,
    Date,
    Symbol,
    JSON,
    Object,
    Math,
    Number,
    Array,
    String,
    Error,
    RegExp,
    Promise,
    Set,
    Map,
  }
  vm.runInNewContext(clientSource, sandbox, { filename: clientPath })
  assert.ok(definition, 'the bundle must register itself with __ModuleLoader__')
  const exports = definition.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })
  return { definition, exports, react, fetchCalls }
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

function fakeContext() {
  const locales = []
  const injections = []
  const registrations = []
  const dictionaries = new Map()
  function lookup(namespace, key, params) {
    const dictionaries = locales.find((entry) => entry.namespace === namespace)?.dictionaries
    const dict = dictionaries?.zh
    // Mirrors the host: flat dictionaries keyed by the full dotted string, no path traversal.
    const value = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (match, name) =>
      params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
  const ctx = {
    effect(fn) {
      fn()
    },
    locale: {
      register(namespace, dictionariesForNamespace) {
        dictionaries.set(namespace, dictionariesForNamespace)
        locales.push({ namespace, dictionaries: dictionariesForNamespace })
      },
      bind(namespace) {
        return (key, params) => lookup(namespace, key, params)
      },
    },
    slots: {
      inject(name, register) {
        injections.push(name)
        register()
      },
      register(definition, renderer) {
        registrations.push({ definition, renderer })
        return () => {}
      },
    },
  }
  return { ctx, locales, injections, registrations }
}

test('the client bundle loads without touching the network', () => {
  const { definition, exports, fetchCalls } = loadClient()
  assert.equal(definition.id, 'dsh-commit-guard')
  assert.equal(exports.name, 'dsh-commit-guard-client')
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(fetchCalls.length, 0)
})

test('apply registers locale copy and both UI slots', () => {
  const { exports } = loadClient()
  const io = fakeContext()
  exports.apply(io.ctx)

  assert.deepEqual(io.locales.map((entry) => entry.namespace), ['settings.commit-guard'])
  const { zh, en } = io.locales[0].dictionaries
  for (const dictionary of [zh, en]) {
    assert.equal(typeof dictionary.title, 'string')
    assert.equal(typeof dictionary.enabledOff, 'string')
    assert.equal(typeof dictionary.disclosureQuit, 'string')
    for (const key of ['disclosure1', 'disclosure2', 'disclosure3', 'disclosure4', 'disclosure5']) {
      assert.equal(typeof dictionary[key], 'string')
    }
    assert.ok(dictionary['toast.settings.autoRestart.on'])
    assert.ok(dictionary['toast.settings.autoRestart.off'])
    assert.equal(typeof dictionary['state.normal'], 'string')
    assert.equal(typeof dictionary['action.observing'], 'string')
    assert.equal(typeof dictionary['actionDetail.waiting'], 'string')
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `locale entry ${key} must be a flat string`)
    }
  }
  assert.match(en.enabledOff, /off/)
  assert.match(zh.enabledOff, /已关闭/)
  assert.deepEqual(io.injections, ['plugins.bundle.config', 'shell.overlay'])
  assert.equal(io.registrations.length, 2)

  const [card, overlay] = io.registrations
  assert.equal(card.definition.name, 'plugins.bundle.config')
  assert.equal(card.definition.key, 'dsh-commit-guard')
  assert.equal(card.definition.locale, 'settings.commit-guard')
  assert.equal(typeof card.definition.inject, 'function')
  const injected = card.definition.inject()
  assert.equal(typeof injected.t, 'function')

  assert.equal(overlay.definition.name, 'shell.overlay')
  assert.equal(overlay.definition.id, 'dsh-commit-guard.overlay')
  assert.equal(overlay.definition.locale, 'settings.commit-guard')
})

test('dotted locale keys resolve through the flat host dictionary', () => {
  const { exports } = loadClient()
  const io = fakeContext()
  exports.apply(io.ctx)
  const t = io.ctx.locale.bind('settings.commit-guard')

  assert.equal(t('state.normal'), '正常')
  assert.equal(t('action.waiting'), '等待空闲')
  assert.equal(t('actionDetail.waiting'), '检测到任务正在运行，确认空闲后才会重启。')
  assert.equal(t('toast.settings.autoRestart.on'), '自动重启已开启。')
  assert.equal(t('toast.action.canceled.recovered', { reason: 'x' }), '内存压力恢复，已取消待执行重启。')
})

test('the config slot hides the summary and renders the guard card on the page', () => {
  const { exports } = loadClient()
  const io = fakeContext()
  exports.apply(io.ctx)
  const { renderer, definition } = io.registrations[0]

  assert.equal(renderer({ view: 'summary' }), null)
  const page = renderer({ view: 'page' })
  assert.equal(typeof page.type, 'function')
  assert.equal(typeof page.props.t, 'function')

  const tree = page.type(page.props)
  assert.equal(tree.type, 'div')
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? String(value.name) : value))
  assert.match(text, /DSH 提交内存守护/)
  assert.match(text, /正在读取状态/)

  const disclosureElement = tree.props.children.find(
    (child) => child && typeof child.type === 'function' && child.type.name === 'Disclosure',
  )
  assert.ok(disclosureElement, 'the permanent disclosure must render even before status loads')
  const disclosure = disclosureElement.type(disclosureElement.props)
  const disclosureText = JSON.stringify(disclosure, (key, value) => (typeof value === 'function' ? String(value.name) : value))
  assert.match(disclosureText, /开启前请确认/)
  assert.match(disclosureText, /未发送的草稿/)
  assert.match(disclosureText, /原生退出确认框/)
  assert.match(disclosureText, /外部软件/)
  assert.match(disclosureText, /30 分钟内最多重启一次/)
  assert.match(disclosureText, /只有 DSH 进程树占到提交内存的 20%/)
  assert.match(disclosureText, /崩溃续接默认关闭/)
})

test('the overlay slot renders the passive overlay element', () => {
  const { exports } = loadClient()
  const io = fakeContext()
  exports.apply(io.ctx)
  const { renderer } = io.registrations[1]

  const element = renderer({ view: 'page' })
  assert.equal(typeof element.type, 'function')
  assert.equal(element.type.name, 'GuardOverlay')

  const tree = element.type(element.props)
  assert.equal(typeof tree.type, 'function')
  assert.equal(tree.type.name, 'ToastStack')
})

function fullStatus() {
  return {
    ok: true,
    plugin: { name: 'dsh-commit-guard', version: '0.2.0', startedAt: 1, hostPid: 4242, hostRss: 128 * 1024 * 1024 },
    platform: { supported: true, platform: 'win32', arch: 'x64', reason: null },
    autoRestart: { enabled: false, capability: { state: 'unavailable', ok: false, reason: 'helper job missing', checkedAt: 1, hint: 'capability.hint.job' } },
    config: {
      autoRestart: false,
      resumeAfterCrash: true,
      thresholds: {
        warningPct: 80,
        criticalPct: 90,
        criticalAvailMb: 2048,
        confirmSamples: 3,
        cooldownMinutes: 30,
        restartGatePct: 20,
      },
    },
    pressure: {
      state: 'warning',
      stale: false,
      pct: 82.4,
      commitUsed: 40 * 1024 ** 3,
      commitLimit: 48 * 1024 ** 3,
      availableCommit: 8 * 1024 ** 3,
      physicalTotal: 32 * 1024 ** 3,
      physicalAvailable: 6 * 1024 ** 3,
      sampleAgeMs: 1200,
    },
    action: { state: 'observing', cancelable: false },
    cooldown: { active: false, remainingMs: 0 },
    episode: { id: null, attempted: false, canceled: false },
    activity: { idle: true, reason: null },
    collector: { running: true, pid: 777, sampleAgeMs: 1200 },
    gate: { allowed: true, code: 'gate.passed', gatePct: 20, sharePct: 41.2 },
    residents: {
      tracked: 2,
      growMb: 512,
      windowMs: 300000,
      alerts: [
        {
          pid: 10428,
          name: 'node.exe',
          dsh: false,
          bytes: 5 * 1024 ** 3,
          growthBytes: 1024 ** 3,
          spanMs: 6 * 60 * 1000,
          ageMin: 240,
          exePath: 'E:\\nodejs\\node.exe',
          at: 9,
        },
      ],
    },
    attribution: {
      ok: true,
      at: 2,
      ageMs: 1500,
      error: null,
      systemCommitUsed: 40 * 1024 ** 3,
      dshBytes: 16 * 1024 ** 3,
      dshCount: 6,
      sharePct: 41.2,
      top: [
        { pid: 4242, parentPid: 1, name: 'DeepSeek Harness.exe', bytes: 12 * 1024 ** 3, dsh: true },
        { pid: 999, parentPid: 1, name: 'chrome.exe', bytes: 4 * 1024 ** 3, dsh: false },
      ],
    },
    system: {
      ok: true,
      commitUsed: 40 * 1024 ** 3,
      commitLimit: 48 * 1024 ** 3,
      physicalTotal: 32 * 1024 ** 3,
      physicalAvailable: 6 * 1024 ** 3,
      pagefiles: [{ path: 'D:\\pagefile.sys', currentMb: 10000, exists: true, systemVolume: false }],
      advice: [{ code: 'pagefile.ok', severity: 'ok', suggestionMb: null, pagefileMb: 10000, headroomMb: 16384 }],
    },
    crashes: {
      ok: true,
      days: 7,
      crashCount: 2,
      eventCount: 5,
      items: [
        { at: 3, code: 'crash.renderer-oom', severity: 'critical', detail: 'Error: Desktop renderer exited: oom at C:/Users/someone/app.js', sources: ['renderer'] },
        { at: 4, code: 'system.resource-exhaustion', severity: 'warn', detail: 'node.exe used most of the commit charge', sources: ['windows-event'] },
      ],
    },
    history: [
      { kind: 'pressure-critical', at: 5, pressure: { pct: 91.5 } },
      { kind: 'restart-failed', at: 6, pressure: { pct: 90.1 } },
    ],
    resume: {
      enabled: true,
      scanning: false,
      lastScanAt: 7,
      lastScan: { ok: true, resumed: 1, candidates: 2, deferred: [] },
      ledger: [{ sessionId: 'session-abcdef123456', attempts: 1, lastTurn: 4, lastCause: 'child', at: 7 }],
      maxAttempts: 2,
      windowMs: 12 * 60 * 60 * 1000,
    },
    lastEvent: { kind: 'pressure-warning', at: 8 },
    lastRestart: null,
    lastError: { source: 'handoff', message: 'helper job missing' },
    notices: [],
  }
}

test('the zh and en dictionaries cover the same keys', () => {
  const { exports } = loadClient()
  const io = fakeContext()
  exports.apply(io.ctx)
  const { zh, en } = io.locales[0].dictionaries
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys)
  for (const key of [
    'attributionTitle',
    'gate.passed',
    'gate.share-below',
    'systemTitle',
    'advice.pagefile-none',
    'crashTitle',
    'crashCodes.crash.renderer-oom',
    'historyKinds.pressure-critical',
    'resumeTitle',
    'resumeLedgerItem',
    'capabilityHints.job',
    'copyDiagnostics',
    'exportEvents',
    'toast.settings.thresholds',
    'toast.settings.resume.on',
    'toast.action.skipped.external',
    'disclosure6',
    'disclosure7',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `missing ${key}`)
    assert.equal(typeof zh[key], 'string')
  }
})

test('the guard card renders the attribution, pagefile, crash, history and resume sections', async () => {
  const { exports } = loadClient({ status: fullStatus() })
  const io = fakeContext()
  exports.apply(io.ctx)
  const { renderer } = io.registrations[0]

  const element = renderer({ view: 'page' })
  const props = { t: io.ctx.locale.bind('settings.commit-guard') }
  element.type(props)
  await flush()
  const tree = element.type(props)
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? String(value.name) : value))
  assert.match(text, /提交内存归因/)
  assert.match(text, /DeepSeek Harness\.exe/)
  assert.match(text, /增长盯梢（5 分钟窗口）/)
  assert.match(text, /node\.exe（PID 10428）在 6m 0s 里涨了 1\.00 GiB，现在 5\.00 GiB（已运行 4h 0m）/)
  assert.match(text, /重启 DSH 不会把它降下来/)
  assert.match(text, /可执行文件：E:.*nodejs.*node\.exe/)
  assert.match(text, /DSH 进程树 6 个进程/)
  assert.match(text, /已通过：DSH 是当前主要占用者/)
  assert.match(text, /虚拟内存配置（只读）/)
  assert.match(text, /pagefile\.sys/)
  assert.match(text, /分页文件与提交上限看起来正常/)
  assert.match(text, /本插件不会修改任何系统设置/)
  assert.match(text, /崩溃与内存事件（最近 7 天）/)
  assert.match(text, /渲染进程内存耗尽（OOM）/)
  assert.match(text, /Windows 报告虚拟内存耗尽/)
  assert.match(text, /最近事件/)
  assert.match(text, /进入危险/)
  assert.match(text, /重启失败/)
  assert.match(text, /崩溃后自动续接/)
  assert.match(text, /已开启：DSH 重启后会自动续接被中断的对话/)
  assert.match(text, /session-/)
  assert.match(text, /子代理中断/)
  assert.match(text, /复制诊断信息/)
  assert.match(text, /导出事件 JSON/)
  assert.match(text, /立即扫描/)
  assert.match(text, /作业对象/)
})

test('the card stays read-only: no button posts a restart or a config change', async () => {
  const { exports, fetchCalls } = loadClient({ status: fullStatus() })
  const io = fakeContext()
  exports.apply(io.ctx)
  const element = io.registrations[0].renderer({ view: 'page' })
  element.type({ t: io.ctx.locale.bind('settings.commit-guard') })
  await flush()
  const paths = fetchCalls.map((call) => call.url)
  assert.deepEqual(paths, ['/api/commit-guard.status'])
})

test('diagnostics summarize the status without crash bodies or long session ids', () => {
  const { exports } = loadClient()
  const text = exports.buildDiagnostics(fullStatus())
  assert.match(text, /dsh-commit-guard 0\.2\.0/)
  assert.match(text, /pressure: warning 82\.4%/)
  assert.match(text, /thresholds: warning 80% critical 90%/)
  assert.match(text, /gate\.passed share=41\.2%/)
  assert.match(text, /DeepSeek Harness\.exe 12\.0 GiB/)
  assert.match(text, /D:\\pagefile\.sys 9\.77 GiB/)
  assert.match(text, /advice: pagefile\.ok/)
  assert.match(text, /crashes: 2 dsh, 5 system events in 7 days/)
  assert.match(text, /resume: on/)
  assert.match(text, /session- x1/)
  assert.match(text, /lastError: handoff: helper job missing/)
  assert.doesNotMatch(text, /Users\/someone/)
  assert.doesNotMatch(text, /abcdef123456/)
  assert.equal(exports.buildDiagnostics(null), 'dsh-commit-guard: no status')
})
