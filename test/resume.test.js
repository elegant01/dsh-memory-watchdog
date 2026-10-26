import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPromptText,
  normalizeResumeLedger,
  requestIdFor,
  ResumeManager,
  tailTurnEndOf,
  withinWindow,
} from '../lib/resume.js'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function turnEnd(kind, turn, time = NOW - 30_000) {
  return { type: 'turn/end', time, data: { turn, reason: { kind } } }
}

function summary(sessionId, extra = {}) {
  return { sessionId, origin: 'user', blank: false, running: false, updatedAt: NOW - 1000, ...extra }
}

function fakeController({ items, tails, promptError = null }) {
  const prompts = []
  const calls = { list: 0, inspect: 0 }
  return {
    prompts,
    calls,
    async list() {
      calls.list += 1
      return { items }
    },
    async inspect(sessionId) {
      calls.inspect += 1
      const events = tails[sessionId]
      if (events === undefined) throw new Error(`no session ${sessionId}`)
      return { events: typeof events === 'function' ? events() : events }
    },
    async prompt(payload) {
      if (promptError !== null) throw promptError
      prompts.push(payload)
    },
  }
}

function manager(controller, options = {}) {
  const persisted = []
  const resume = new ResumeManager({
    now: () => options.now ?? NOW,
    controller,
    quietMs: options.quietMs ?? 20_000,
    maxAttempts: options.maxAttempts ?? 2,
    windowMs: options.windowMs ?? 12 * HOUR,
    logMtime: () => (options.now ?? NOW) - 1000,
    persist: async (ledger) => {
      persisted.push(JSON.parse(JSON.stringify(ledger)))
    },
  })
  return { resume, persisted }
}

test('tail scanning and request ids are stable', () => {
  const events = [{ type: 'user/message' }, { type: 'turn/end', time: 5, data: { turn: 2, reason: { kind: 'interrupted' } } }]
  assert.deepEqual(tailTurnEndOf(events), { kind: 'interrupted', time: 5, turn: 2 })
  assert.equal(tailTurnEndOf([]), undefined)
  assert.equal(tailTurnEndOf(null), undefined)
  assert.equal(requestIdFor('s1', 4), 'commit-guard-resume-s1-4')
  assert.equal(requestIdFor('s1', 4, 'child'), 'commit-guard-resume-s1-4-child')
  assert.match(buildPromptText(7), /turn 7/)
  assert.match(buildPromptText(7), /not a new request/)
  assert.equal(withinWindow({ updatedAt: NOW - 1000 }, NOW, 12 * HOUR), true)
  assert.equal(withinWindow({ updatedAt: NOW - 13 * HOUR }, NOW, 12 * HOUR), false)
  assert.equal(withinWindow({}, NOW, 12 * HOUR), false)
})

test('an interrupted session is resumed once with an idempotent request id', async () => {
  const controller = fakeController({
    items: [summary('s1')],
    tails: { s1: [turnEnd('interrupted', 4)] },
  })
  const { resume, persisted } = manager(controller)
  const result = await resume.scanNow()
  assert.equal(result.ok, true)
  assert.equal(result.candidates, 1)
  assert.equal(result.resumed, 1)
  assert.equal(controller.prompts.length, 1)
  assert.equal(controller.prompts[0].sessionId, 's1')
  assert.equal(controller.prompts[0].mode, 'queue')
  assert.equal(controller.prompts[0].requestId, 'commit-guard-resume-s1-4')
  assert.equal(controller.prompts[0].content[0].type, 'text')
  assert.match(controller.prompts[0].content[0].text, /verify the real current state/)
  assert.equal(persisted.length, 1)
  assert.deepEqual(resume.ledger.sessions.s1, {
    attempts: 1,
    lastTurn: 4,
    lastCause: 'self',
    at: NOW,
    lastKind: 'interrupted',
  })
  assert.equal(resume.state().enabled, false)

  const second = await resume.scanNow()
  assert.equal(second.resumed, 0)
  assert.equal(controller.prompts.length, 1)
  assert.ok(second.skipped.some((entry) => entry.code === 'resume.already-handled'))
})

test('a user-canceled turn is never resumed', async () => {
  const controller = fakeController({
    items: [summary('s1')],
    tails: { s1: [turnEnd('aborted', 3)] },
  })
  const { resume } = manager(controller)
  const result = await resume.scanNow()
  assert.equal(result.resumed, 0)
  assert.equal(controller.prompts.length, 0)
  assert.ok(result.skipped.some((entry) => entry.code === 'resume.user-canceled'))
})

test('running, blank, subagent and stale sessions are ignored', async () => {
  const controller = fakeController({
    items: [
      summary('running', { running: true }),
      summary('blank', { blank: true }),
      summary('child', { origin: 'subagent', parentSessionId: 'parent' }),
      summary('stale', { updatedAt: NOW - 13 * HOUR }),
    ],
    tails: {
      running: [turnEnd('interrupted', 1)],
      blank: [turnEnd('interrupted', 1)],
      child: [turnEnd('interrupted', 1)],
      stale: [turnEnd('interrupted', 1)],
    },
  })
  const { resume } = manager(controller)
  const result = await resume.scanNow()
  assert.equal(result.resumed, 0)
  assert.equal(controller.prompts.length, 0)
  assert.deepEqual(result.skipped.map((entry) => entry.code), ['resume.running'])
})

test('a recent interruption is deferred, then resumed when the quiet period ends', async () => {
  const tail = turnEnd('interrupted', 5, NOW - 5000)
  const controller = fakeController({ items: [summary('s1')], tails: { s1: [tail] } })
  const clock = { now: NOW }
  const resume = new ResumeManager({
    now: () => clock.now,
    controller,
    quietMs: 20_000,
    logMtime: () => clock.now - 1000,
    persist: async () => {},
  })
  const first = await resume.scanNow()
  assert.equal(first.resumed, 0)
  assert.equal(first.deferred.length, 1)
  assert.equal(first.nextDueAt, NOW - 5000 + 20_000)
  assert.ok(first.skipped.some((entry) => entry.code === 'resume.quiet-period'))

  clock.now += 20_000
  const second = await resume.scanNow()
  assert.equal(second.resumed, 1)
  assert.equal(controller.prompts.length, 1)
})

test('attempts are capped in a sliding window', async () => {
  let turn = 0
  const controller = fakeController({
    items: [summary('s1')],
    tails: { s1: () => [turnEnd('interrupted', (turn += 1))] },
  })
  const { resume } = manager(controller, { maxAttempts: 2 })
  await resume.scanNow()
  await resume.scanNow()
  const third = await resume.scanNow()
  assert.equal(third.resumed, 0)
  assert.equal(controller.prompts.length, 2)
  assert.ok(third.skipped.some((entry) => entry.code === 'resume.attempt-limit'))

  resume.ledger.sessions.s1.at = NOW - 2 * HOUR
  const fourth = await resume.scanNow()
  assert.equal(fourth.resumed, 1)
  assert.equal(controller.prompts.length, 3)
  assert.equal(resume.ledger.sessions.s1.attempts, 1)
})

test('an interrupted subagent wakes its parent exactly once', async () => {
  const controller = fakeController({
    items: [
      summary('parent'),
      summary('child', { origin: 'subagent', parentSessionId: 'parent' }),
    ],
    tails: {
      parent: [turnEnd('completed', 7)],
      child: [turnEnd('interrupted', 2, NOW - 40_000)],
    },
  })
  const { resume } = manager(controller)
  const first = await resume.scanNow()
  assert.equal(first.resumed, 1)
  assert.equal(controller.prompts.length, 1)
  assert.equal(controller.prompts[0].sessionId, 'parent')
  assert.equal(controller.prompts[0].requestId, 'commit-guard-resume-parent-7-child')
  assert.equal(resume.ledger.childHandled.child, true)

  const second = await resume.scanNow()
  assert.equal(second.resumed, 0)
  assert.equal(controller.prompts.length, 1)
})

test('a failed prompt is recorded but not retried for the same turn', async () => {
  const controller = fakeController({
    items: [summary('s1')],
    tails: { s1: [turnEnd('interrupted', 9)] },
    promptError: new Error('queue rejected'),
  })
  const { resume } = manager(controller)
  const result = await resume.scanNow()
  assert.equal(result.resumed, 0)
  assert.equal(result.actions[0].status, 'failed')
  assert.match(result.actions[0].error, /queue rejected/)
  assert.equal(resume.ledger.sessions.s1.attempts, 1)

  const again = await resume.scanNow()
  assert.equal(again.actions.length, 0)
  assert.ok(again.skipped.some((entry) => entry.code === 'resume.already-handled'))
})

test('inspect failures and a missing controller are reported, not thrown', async () => {
  const broken = fakeController({ items: [summary('s1')], tails: {} })
  const { resume } = manager(broken)
  const result = await resume.scanNow()
  assert.equal(result.ok, true)
  assert.ok(result.skipped.some((entry) => entry.code === 'resume.inspect-failed'))

  const missing = new ResumeManager({ now: () => NOW, ctx: { get: () => undefined } })
  const absent = await missing.scanNow()
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'resume.no-controller')
})

test('ledger normalization drops junk and keeps known fields', () => {
  const ledger = normalizeResumeLedger({
    sessions: {
      good: { attempts: 2, lastTurn: 3, lastCause: 'child', at: 100, lastKind: 'interrupted' },
      bad: { attempts: 'many' },
      nullish: null,
    },
    childHandled: { c1: true, c2: false },
    unsupported: { s9: 1 },
  })
  assert.deepEqual(ledger.sessions, {
    good: { attempts: 2, lastTurn: 3, lastCause: 'child', at: 100, lastKind: 'interrupted' },
  })
  assert.deepEqual(ledger.childHandled, { c1: true, c2: true })
  assert.deepEqual(ledger.unsupported, { s9: true })
  assert.deepEqual(normalizeResumeLedger(null).sessions, {})
})
