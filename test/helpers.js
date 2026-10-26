import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const GIB = 1024 ** 3
export const DEFAULT_LIMIT = 100 * GIB

export function makeClock(start = 1_700_000_000_000) {
  const clock = { now: start }
  clock.set = (value) => {
    clock.now = value
  }
  clock.advance = (ms) => {
    clock.now += ms
  }
  return clock
}

export function sample(pct, ts, { limit = DEFAULT_LIMIT, physicalTotal = 64 * GIB, physicalAvailable = 32 * GIB } = {}) {
  const commitUsed = Math.round((limit * pct) / 100)
  return { ts, commitUsed, commitLimit: limit, physicalTotal, physicalAvailable }
}

export function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function primeNormal(feed) {
  await feed(70)
  await feed(70)
  await feed(70)
}

export async function driveToWarning(feed) {
  await primeNormal(feed)
  await feed(82)
  await feed(82)
  await feed(82)
}

export async function driveToCritical(feed) {
  await driveToWarning(feed)
  await feed(96)
  await feed(96)
  await feed(96)
}

export async function makeTempDir(prefix = 'dsh-memory-watchdog-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export function fakeAgent(id, extra = {}) {
  return {
    id,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ...extra,
  }
}

export function activityContext({ agents, jobs } = {}) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'agents') {
          return {
            list: async () => {
              if (typeof agents === 'function') return agents()
              return agents ?? []
            },
          }
        }
        if (name === 'jobs') {
          return {
            list: async (scope) => {
              calls.push(scope)
              if (typeof jobs === 'function') return jobs(scope)
              if (jobs !== undefined) return jobs
              return []
            },
          }
        }
        return undefined
      },
    },
  }
}
