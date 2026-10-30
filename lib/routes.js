import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { HISTORY_LIMIT } from './constants.js'

const STATUS_PATH = '/api/memory-watchdog.status'
const CANCEL_PATH = '/api/memory-watchdog.cancel'
const EVENTS_PATH = '/api/memory-watchdog.events'
const RESUME_PATH = '/api/memory-watchdog.resume'
const PLUGINS_PATH = '/api/memory-watchdog.plugins'
const PLUGINS_SAMPLE_PATH = '/api/memory-watchdog.plugins-sample'
const PLUGINS_EXPORT_PATH = '/api/memory-watchdog.plugins-export'
const SNAPSHOT_PATH = '/api/memory-watchdog.snapshot'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  })
}

function isJsonContentType(request) {
  const value = request.headers.get('content-type')
  return typeof value === 'string' && value.toLowerCase().split(';')[0].trim() === 'application/json'
}

async function readJsonObject(request) {
  if (!isJsonContentType(request)) {
    return { error: jsonResponse({ ok: false, code: 'unsupported-media-type', error: 'POST requires application/json' }, 415) }
  }
  let body
  try {
    const text = await request.text()
    body = text.trim().length === 0 ? null : JSON.parse(text)
  } catch {
    return { error: jsonResponse({ ok: false, code: 'invalid-json', error: 'request body must be valid JSON' }, 400) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: jsonResponse({ ok: false, code: 'invalid-body', error: 'request body must be a JSON object' }, 400) }
  }
  return { body }
}

function queryLimit(request, fallback) {
  const raw = Number(new URL(request.url).searchParams.get('limit'))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(HISTORY_LIMIT, Math.round(raw))
}

async function fileResponse(path) {
  const bytes = await readFile(path)
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${basename(path)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  })
}

function pluginResultStatus(result) {
  if (result.ok === true) return 200
  if (result.code === 'plugins-disabled' || result.code === 'sampling-disabled') return 409
  return 503
}

export function registerRoutes(ctx, runtime) {
  const connection = ctx.connection
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
    throw new Error('dsh-memory-watchdog: the connection.fetch service is unavailable')
  }
  const statusRoute = connection.fetch.register({
    path: STATUS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(runtime.status()),
  })
  const eventsRoute = connection.fetch.register({
    path: EVENTS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) =>
      jsonResponse({
        ok: true,
        limit: queryLimit(request, HISTORY_LIMIT),
        items: runtime.historyItems(queryLimit(request, HISTORY_LIMIT)),
      }),
  })
  const cancelRoute = connection.fetch.register({
    path: CANCEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const parsed = await readJsonObject(request)
      if (parsed.error !== undefined) return parsed.error
      const result = await runtime.cancel()
      return jsonResponse(result, result.ok === true ? 200 : 409)
    },
  })
  const resumeRoute = connection.fetch.register({
    path: RESUME_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const parsed = await readJsonObject(request)
      if (parsed.error !== undefined) return parsed.error
      const result = await runtime.resumeNow()
      if (result.ok === true) return jsonResponse(result, 200)
      return jsonResponse(result, result.code === 'resume-disabled' ? 409 : 503)
    },
  })
  const pluginsRoute = connection.fetch.register({
    path: PLUGINS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const plugins = runtime.pluginStatus()
      if (plugins === null) return jsonResponse({ ok: false, code: 'plugins-disabled', error: 'plugin memory is disabled' }, 409)
      return jsonResponse({ ok: true, plugins })
    },
  })
  const pluginsSampleRoute = connection.fetch.register({
    path: PLUGINS_SAMPLE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const parsed = await readJsonObject(request)
      if (parsed.error !== undefined) return parsed.error
      const result = await runtime.samplePlugins()
      return jsonResponse(result, pluginResultStatus(result))
    },
  })
  const pluginsExportRoute = connection.fetch.register({
    path: PLUGINS_EXPORT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const result = await runtime.exportPluginProfile()
      if (result.ok !== true) return jsonResponse(result, pluginResultStatus(result))
      try {
        return await fileResponse(result.path)
      } catch (error) {
        return jsonResponse({ ok: false, code: 'export-read-failed', error: String(error?.message ?? error) }, 500)
      }
    },
  })
  const snapshotRoute = connection.fetch.register({
    path: SNAPSHOT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const parsed = await readJsonObject(request)
      if (parsed.error !== undefined) return parsed.error
      const result = await runtime.snapshotPlugins()
      return jsonResponse(result, pluginResultStatus(result))
    },
  })
  return () => {
    statusRoute?.()
    eventsRoute?.()
    cancelRoute?.()
    resumeRoute?.()
    pluginsRoute?.()
    pluginsSampleRoute?.()
    pluginsExportRoute?.()
    snapshotRoute?.()
  }
}

export {
  STATUS_PATH,
  CANCEL_PATH,
  EVENTS_PATH,
  RESUME_PATH,
  PLUGINS_PATH,
  PLUGINS_SAMPLE_PATH,
  PLUGINS_EXPORT_PATH,
  SNAPSHOT_PATH,
  jsonResponse,
  isJsonContentType,
}
