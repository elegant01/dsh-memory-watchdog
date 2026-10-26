import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectActivity } from '../lib/activity.js'
import { activityContext, fakeAgent } from './helpers.js'

test('idle when no agents and no jobs exist', async () => {
  const { ctx, calls } = activityContext({ agents: [], jobs: [] })
  const result = await inspectActivity(ctx, { now: () => 123 })
  assert.deepEqual(result, { idle: true, reason: null, checkedAt: 123 })
  assert.deepEqual(calls, [undefined])
})

test('a running agent makes the guard busy', async () => {
  const { ctx } = activityContext({ agents: [fakeAgent('main', { status: 'running' })], jobs: [] })
  const result = await inspectActivity(ctx)
  assert.equal(result.idle, false)
  assert.equal(result.reason, 'agent-running')
})

test('queued nextTurn and nextStep work both count as busy', async () => {
  const turn = activityContext({
    agents: [fakeAgent('main', { inbox: { nextTurn: ['task'], nextStep: [] } })],
    jobs: [],
  })
  assert.equal((await inspectActivity(turn.ctx)).reason, 'agent-queued')

  const step = activityContext({
    agents: [fakeAgent('main', { inbox: { nextTurn: [], nextStep: ['step'] } })],
    jobs: [],
  })
  assert.equal((await inspectActivity(step.ctx)).reason, 'agent-queued')
})

test('unreadable inbox is not treated as idle', async () => {
  const { ctx } = activityContext({ agents: [fakeAgent('main', { inbox: null })], jobs: [] })
  const result = await inspectActivity(ctx)
  assert.equal(result.idle, false)
  assert.equal(result.reason, 'agent-queue-unreadable')
})

test('running and stopping jobs are busy in the global and per-agent scopes', async () => {
  const globalJobs = activityContext({
    agents: [fakeAgent('agent-a'), fakeAgent('agent-b')],
    jobs: [
      { id: 'j1', status: 'running' },
      { id: 'j2', status: 'stopping' },
    ],
  })
  const globalResult = await inspectActivity(globalJobs.ctx)
  assert.equal(globalResult.idle, false)
  assert.equal(globalResult.reason, 'job-active')
  assert.deepEqual(globalJobs.calls, [undefined])

  const perAgent = activityContext({
    agents: [fakeAgent('agent-a'), fakeAgent('agent-b')],
    jobs: (scope) => (scope === 'agent-a' ? [{ id: 'j3', status: 'stopping' }] : []),
  })
  const perAgentResult = await inspectActivity(perAgent.ctx)
  assert.equal(perAgentResult.idle, false)
  assert.equal(perAgentResult.reason, 'job-active')
  assert.deepEqual(perAgent.calls, [undefined, 'agent-a'])
})

test('a running job under one agent blocks even when the global list is empty', async () => {
  const { ctx } = activityContext({
    agents: [fakeAgent('agent-a'), fakeAgent('agent-b')],
    jobs: (scope) => (scope === 'agent-b' ? [{ id: 'j9', status: 'running' }] : []),
  })
  const result = await inspectActivity(ctx)
  assert.equal(result.idle, false)
  assert.equal(result.reason, 'job-active')
})

test('finished jobs do not block idle confirmation', async () => {
  const { ctx } = activityContext({
    agents: [fakeAgent('agent-a')],
    jobs: [{ id: 'j1', status: 'done' }, { id: 'j2', status: 'failed' }],
  })
  const result = await inspectActivity(ctx)
  assert.equal(result.idle, true)
})

test('missing activity services fail closed', async () => {
  const noAgents = { get: (name) => (name === 'jobs' ? { list: async () => [] } : undefined) }
  assert.equal((await inspectActivity(noAgents)).reason, 'agents-unavailable')

  const noJobs = { get: (name) => (name === 'agents' ? { list: async () => [] } : undefined) }
  assert.equal((await inspectActivity(noJobs)).reason, 'jobs-unavailable')

  assert.equal((await inspectActivity({})).reason, 'agents-unavailable')
  assert.equal((await inspectActivity(null)).reason, 'agents-unavailable')
})

test('malformed structures and API errors fail closed', async () => {
  const malformedAgents = { get: (name) => (name === 'agents' ? { list: async () => ({}) } : { list: async () => [] }) }
  assert.equal((await inspectActivity(malformedAgents)).reason, 'agents-malformed')

  const malformedJob = activityContext({ agents: [fakeAgent('a')], jobs: [{ id: 'x' }] })
  assert.equal((await inspectActivity(malformedJob.ctx)).reason, 'job-status-unreadable')

  const throwing = {
    get(name) {
      if (name === 'agents') return { list: async () => { throw new Error('boom') } }
      return { list: async () => [] }
    },
  }
  const result = await inspectActivity(throwing)
  assert.equal(result.idle, false)
  assert.equal(result.reason, 'activity-error: boom')
})

test('an agent without a status is never assumed idle', async () => {
  const { ctx } = activityContext({ agents: [{ id: 'a', inbox: { nextTurn: [], nextStep: [] } }], jobs: [] })
  const result = await inspectActivity(ctx)
  assert.equal(result.idle, false)
  assert.equal(result.reason, 'agent-status-unreadable')
})

test('per-agent scopes are queried even when no agent is running', async () => {
  const { ctx, calls } = activityContext({ agents: [fakeAgent('one'), fakeAgent('two')], jobs: [] })
  await inspectActivity(ctx)
  assert.deepEqual(calls, [undefined, 'one', 'two'])
})
