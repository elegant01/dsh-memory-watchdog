import test from 'node:test'
import assert from 'node:assert/strict'
import { extractErrorLine, parseCrashHistory, parseCrashLogName, sampleCrashHistory } from '../lib/crash-history.js'

const DAY = 24 * 60 * 60 * 1000

function head(source, errorLine, pid = 1234) {
  return `time: 2026-10-26T04:40:32.094Z\nsource: ${source}\nshell pid: ${pid}\n\n--- error ---\n${errorLine}\n    at somewhere (app.asar:1:2)\n\n--- next ---\nignored`
}

test('crash log file names decode the timestamp and source', () => {
  const parsed = parseCrashLogName('crash-2026-10-26T04-40-32-094Z-renderer.log')
  assert.equal(parsed.source, 'renderer')
  assert.equal(parsed.at, Date.UTC(2026, 9, 26, 4, 40, 32, 94))
  assert.equal(parseCrashLogName('other.log'), null)
  assert.equal(parseCrashLogName(undefined), null)
})

test('the first line of the error section becomes the detail', () => {
  assert.equal(extractErrorLine(head('renderer', 'Error: Desktop renderer exited: oom')), 'Error: Desktop renderer exited: oom')
  assert.equal(extractErrorLine('no sections here'), null)
  assert.equal(extractErrorLine('--- error ---\n\n--- next ---'), null)
})

test('crash logs from one incident merge into a single prioritized item', () => {
  const now = 200000
  const value = {
    ok: true,
    ts: 150,
    logDir: 'logs',
    logs: [
      { name: 'crash-2026-01-01T00-00-01-000Z-web-boot.log', at: 3000, head: head('web-boot', 'Error: boot failed') },
      { name: 'crash-2026-01-01T00-00-00-500Z-main.log', at: 2500, head: head('main', 'Error: net failure') },
      { name: 'crash-2026-01-01T00-00-00-000Z-renderer.log', at: 2000, head: head('renderer', 'Error: Desktop renderer exited: oom') },
      { name: 'crash-2026-01-01T00-00-00-000Z-host.log', at: 100000 - 7 * DAY, head: head('host', 'Error: host exited with 1') },
    ],
    events: [],
  }
  const result = parseCrashHistory(value, { now, days: 7 })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  const item = result.items[0]
  assert.equal(item.code, 'crash.renderer-oom')
  assert.equal(item.severity, 'critical')
  assert.deepEqual(item.sources.sort(), ['main', 'renderer', 'web-boot'])
  assert.equal(item.pid, 1234)
  assert.match(item.detail, /oom/)
  assert.equal(result.crashCount, 1)
})

test('windows events are classified by id and mixed into the timeline', () => {
  const now = 200000
  const value = {
    ok: true,
    logs: [],
    events: [
      { at: 160000, id: 41, level: 1, provider: 'Kernel-Power', message: 'unexpected shutdown' },
      { at: 150000, id: 2004, level: 3, provider: 'Resource-Exhaustion', message: 'node.exe used most memory' },
      { at: 140000, id: 26, level: 4, provider: 'Application Popup', message: 'low virtual memory' },
      { at: 130000, id: 6008, level: 2, provider: 'EventLog', message: 'unknown id' },
    ],
  }
  const result = parseCrashHistory(value, { now, days: 7 })
  assert.deepEqual(result.items.map((entry) => entry.code), [
    'system.unexpected-shutdown',
    'system.resource-exhaustion',
    'system.low-virtual-memory',
  ])
  assert.equal(result.items[0].severity, 'critical')
  assert.equal(result.items[1].eventId, 2004)
  assert.equal(result.eventCount, 3)
})

test('the timeline drops old items and honours the limit', () => {
  const now = 10 * DAY
  const value = {
    ok: true,
    logs: [
      { name: 'crash-2026-01-01T00-00-00-000Z-host.log', at: now - 9 * DAY, head: head('host', 'old') },
      { name: 'crash-2026-01-02T00-00-00-000Z-host.log', at: now - DAY, head: head('host', 'newer') },
      { name: 'crash-2026-01-03T00-00-00-000Z-host.log', at: now - 1000, head: head('host', 'newest') },
    ],
    events: [],
  }
  const all = parseCrashHistory(value, { now, days: 7, limit: 10 })
  assert.equal(all.items.length, 2)
  assert.match(all.items[0].detail, /newest/)
  const limited = parseCrashHistory(value, { now, days: 7, limit: 1 })
  assert.equal(limited.items.length, 1)
})

test('a failed probe yields a safe empty timeline', () => {
  const result = parseCrashHistory({ ok: false, error: 'Get-WinEvent failed' }, { now: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Get-WinEvent failed')
  assert.deepEqual(result.items, [])
})

test('sampleCrashHistory passes the window to the script and normalizes output', async () => {
  const ok = await sampleCrashHistory({
    scriptPath: 'x',
    days: 7,
    limit: 20,
    now: () => 5000,
    run: async (options) => {
      assert.deepEqual(options.args, ['-Days', '7', '-Limit', '20'])
      return { ok: true, value: { ok: true, logs: [], events: [] } }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.at, 5000)

  const failed = await sampleCrashHistory({ scriptPath: 'x', now: () => 5001, run: async () => ({ ok: false, error: 'boom' }) })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'boom')
})
