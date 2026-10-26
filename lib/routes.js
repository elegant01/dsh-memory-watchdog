import { HISTORY_LIMIT } from './constants.js'

const STATUS_PATH = '/api/memory-watchdog.status'
const CANCEL_PATH = '/api/memory-watchdog.cancel'
const EVENTS_PATH = '/api/memory-watchdog.events'
const RESUME_PATH = '/api/memory-watchdog.resume'

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
  return () => {
    statusRoute?.()
    eventsRoute?.()
    cancelRoute?.()
    resumeRoute?.()
  }
}

export { STATUS_PATH, CANCEL_PATH, EVENTS_PATH, RESUME_PATH, jsonResponse, isJsonContentType }
