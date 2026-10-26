import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { HISTORY_LIMIT, STORE_VERSION } from './constants.js'
import { readJsonFile, writeJsonAtomic } from './util.js'

export class GuardStore {
  constructor({ dir, now = Date.now }) {
    this.dir = dir
    this.now = now
    this.statePath = join(dir, 'state.json')
    this.eventPath = join(dir, 'last-event.json')
    this.eventsPath = join(dir, 'events.json')
    this.restartPath = join(dir, 'last-restart.json')
    this.capabilityPath = join(dir, 'capability.json')
    this.resumePath = join(dir, 'resume.json')
    this.state = { version: STORE_VERSION, cooldownUntil: 0, lastAttemptAt: 0, attemptedEpisodeId: null }
    this.lastEvent = null
    this.history = []
    this.lastRestart = null
    this.capability = null
    this.resume = null
    this.errors = []
    this.writeQueue = Promise.resolve()
  }

  async load() {
    await mkdir(this.dir, { recursive: true })
    const state = await readJsonFile(this.statePath)
    if (state.ok && state.value !== null && typeof state.value === 'object') {
      this.state = {
        version: STORE_VERSION,
        cooldownUntil: Number.isFinite(state.value.cooldownUntil) ? state.value.cooldownUntil : 0,
        lastAttemptAt: Number.isFinite(state.value.lastAttemptAt) ? state.value.lastAttemptAt : 0,
        attemptedEpisodeId: typeof state.value.attemptedEpisodeId === 'string' ? state.value.attemptedEpisodeId : null,
      }
    } else if (!state.ok && state.code !== 'ENOENT') {
      this.errors.push({ file: 'state.json', error: state.error })
    }

    const event = await readJsonFile(this.eventPath)
    if (event.ok) this.lastEvent = event.value
    else if (event.code !== 'ENOENT') this.errors.push({ file: 'last-event.json', error: event.error })

    const events = await readJsonFile(this.eventsPath)
    if (events.ok) {
      const items = Array.isArray(events.value) ? events.value : events.value?.items
      if (Array.isArray(items)) {
        this.history = items.filter((entry) => entry !== null && typeof entry === 'object').slice(-HISTORY_LIMIT)
      }
    } else if (events.code !== 'ENOENT') {
      this.errors.push({ file: 'events.json', error: events.error })
    }

    const restart = await readJsonFile(this.restartPath)
    if (restart.ok) this.lastRestart = restart.value
    else if (restart.code !== 'ENOENT') this.errors.push({ file: 'last-restart.json', error: restart.error })

    const capability = await readJsonFile(this.capabilityPath)
    if (capability.ok) this.capability = capability.value
    else if (capability.code !== 'ENOENT') this.errors.push({ file: 'capability.json', error: capability.error })

    const resume = await readJsonFile(this.resumePath)
    if (resume.ok) this.resume = resume.value
    else if (resume.code !== 'ENOENT') this.errors.push({ file: 'resume.json', error: resume.error })

    return { errors: [...this.errors] }
  }

  enqueue(task) {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.catch(() => {})
    return run
  }

  cooldownActive(now = this.now()) {
    return this.state.cooldownUntil > now
  }

  cooldownRemaining(now = this.now()) {
    return Math.max(0, this.state.cooldownUntil - now)
  }

  async setCooldown({ until, at = this.now(), episodeId = null }) {
    this.state = {
      ...this.state,
      version: STORE_VERSION,
      cooldownUntil: until,
      lastAttemptAt: at,
      attemptedEpisodeId: episodeId,
    }
    return this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
  }

  async recordEvent(event) {
    this.lastEvent = event
    this.history.push(event)
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT)
    const snapshot = { version: STORE_VERSION, items: [...this.history] }
    return this.enqueue(async () => {
      await writeJsonAtomic(this.eventPath, event)
      await writeJsonAtomic(this.eventsPath, snapshot)
    })
  }

  historyItems(limit = HISTORY_LIMIT) {
    const count = Math.max(0, Math.min(HISTORY_LIMIT, Math.round(limit)))
    return count === 0 ? [] : this.history.slice(-count)
  }

  async writeCapability(value) {
    this.capability = value
    return this.enqueue(() => writeJsonAtomic(this.capabilityPath, value))
  }

  async writeResume(value) {
    this.resume = value
    return this.enqueue(() => writeJsonAtomic(this.resumePath, value))
  }

  async refreshRestart() {
    const restart = await readJsonFile(this.restartPath)
    if (restart.ok) this.lastRestart = restart.value
    return this.lastRestart
  }

  async flush() {
    await this.writeQueue.catch(() => {})
  }
}
