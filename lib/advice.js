import { ADVICE_MAX_ITEMS } from './constants.js'

/**
 * One ordered list of recommendations instead of six scattered blocks. Every
 * entry says what is wrong (`why`), what to do about it (`how`) and whether
 * acting on it is a read-only readout or a real action in the UI — because
 * "重启一下" and "看一眼数值" are not the same kind of advice and mixing them
 * silently is how a list becomes noise.
 *
 * The pagefile entries reuse the existing `advice.<code>` translations, so the
 * merged list is the only place those recommendations are rendered; keeping the
 * old block would show the same sentence twice.
 */
const SEVERITY_RANK = { critical: 0, warn: 1, info: 2, ok: 3 }

function item({ key, code = null, severity, kind, source, why, how, value = null, text = null }) {
  // `text` is the translation key under `adviceTexts`. It defaults to `key`, but
  // a per-plugin entry has a dynamic key (`plugin-<name>`) while the sentence is
  // shared, so the text key has to be nameable independently of the identity.
  return { key, code, severity, kind, source, why, how, value, text: text ?? key }
}

function pagefileItems(system) {
  const advice = Array.isArray(system?.advice) ? system.advice : []
  // Every severity is kept, including `ok`: this list is now the only place the
  // pagefile verdict is rendered, so dropping the healthy line would make a
  // system with a sane pagefile look like it was never checked.
  return advice
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.code === 'string')
    .map((entry) =>
      item({
        key: 'pagefile-' + entry.code.replace(/^pagefile\./, ''),
        code: entry.code,
        severity: entry.severity === 'critical' ? 'critical' : entry.severity === 'warn' ? 'warn' : 'ok',
        kind: 'advice',
        source: 'pagefile',
        why: entry.code,
        how: 'pagefile',
        value: {
          suggestionMb: entry.suggestionMb ?? null,
          pagefileMb: entry.pagefileMb ?? null,
          headroomMb: entry.headroomMb ?? null,
        },
      }),
    )
}

function pressureItems(status, thresholds) {
  const state = status?.pressure?.state
  if (state !== 'critical' && state !== 'warning') return []
  const pct = Number(status?.pressure?.pct)
  const limit = Number(status?.pressure?.commitLimit)
  const used = Number(status?.pressure?.commitUsed)
  return [
    item({
      key: 'pressure-' + state,
      severity: state === 'critical' ? 'critical' : 'warn',
      kind: status?.autoRestart?.enabled === true ? 'action' : 'advice',
      source: 'pressure',
      why: 'pressure',
      how: status?.autoRestart?.enabled === true ? 'restart-enabled' : 'restart-disabled',
      value: {
        pct: Number.isFinite(pct) ? pct : null,
        usedBytes: Number.isFinite(used) ? used : null,
        limitBytes: Number.isFinite(limit) ? limit : null,
        criticalPct: Number(thresholds?.criticalPct) || null,
        warningPct: Number(thresholds?.warningPct) || null,
      },
    }),
  ]
}

function gateItems(status) {
  const gate = status?.gate ?? {}
  // `gate.disabled` means the user set the gate to zero on purpose, and
  // `gate.passed` means nothing is wrong; only the two blocking codes are
  // worth a line, and only while automatic restart is actually on.
  if (status?.autoRestart?.enabled !== true) return []
  if (gate.code !== 'gate.share-below' && gate.code !== 'gate.unavailable' && gate.code !== 'gate.stale') return []
  return [
    item({
      key: 'gate-' + gate.code.replace(/^gate\./, ''),
      code: gate.code,
      severity: gate.code === 'gate.share-below' ? 'info' : 'warn',
      kind: 'advice',
      source: 'gate',
      why: 'gate',
      how: 'gate',
      value: { sharePct: gate.sharePct ?? null, gatePct: gate.gatePct ?? null },
    }),
  ]
}

function pluginItems(plugins) {
  if (plugins?.enabled !== true) return []
  const packages = Array.isArray(plugins.packages) ? plugins.packages : []
  return packages
    .filter((entry) => entry?.level === 'high')
    .slice(0, 3)
    .map((entry) =>
      item({
        key: 'plugin-' + String(entry.key ?? entry.name ?? 'unknown'),
        severity: 'warn',
        kind: 'advice',
        source: 'plugin',
        why: 'plugin-growth',
        how: 'plugin-reload',
        text: 'plugin-growth',
        value: {
          name: entry.name ?? entry.key ?? null,
          bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
          growthBytesPerHour: Number.isFinite(entry.growthBytesPerHour) ? entry.growthBytesPerHour : null,
          leakMb: Number(plugins?.sampling?.leakMb) || null,
        },
      }),
    )
}

function heapItems(status) {
  const items = []
  const heap = status?.heap ?? {}
  if (heap.nearLimit === true) {
    items.push(
      item({
        key: 'heap-near-limit',
        severity: 'warn',
        kind: 'advice',
        source: 'heap',
        why: 'heap-near-limit',
        how: 'restart-or-profile',
        value: {
          ratioPct: Number.isFinite(heap.ratioPct) ? heap.ratioPct : null,
          heapUsed: Number.isFinite(heap.heapUsed) ? heap.heapUsed : null,
          heapTotal: Number.isFinite(heap.heapTotal) ? heap.heapTotal : null,
        },
      }),
    )
  }
  const rate = Number(heap.externalRateMbPerHour)
  if (Number.isFinite(rate) && rate >= 200) {
    items.push(
      item({
        key: 'heap-external-growth',
        severity: 'warn',
        kind: 'advice',
        source: 'heap',
        why: 'heap-external-growth',
        how: 'restart-or-profile',
        value: {
          rateMbPerHour: rate,
          externalBytes: Number.isFinite(heap.externalBytes) ? heap.externalBytes : null,
          arrayBuffersBytes: Number.isFinite(heap.arrayBuffersBytes) ? heap.arrayBuffersBytes : null,
        },
      }),
    )
  }
  return items
}

function crashItems(status) {
  const crashes = status?.crashes ?? {}
  if (crashes.ok !== true) return []
  const count = Number(crashes.crashCount)
  if (!Number.isFinite(count) || count < 2) return []
  const oom = Array.isArray(crashes.items)
    ? crashes.items.find((entry) => entry?.oom?.oomClass)?.oom?.oomClass ?? null
    : null
  return [
    item({
      key: 'crash-recent',
      severity: 'warn',
      kind: 'advice',
      source: 'crash',
      why: 'crash-recent',
      how: 'bundle',
      value: { count, days: Number(crashes.days) || null, oomClass: oom },
    }),
  ]
}

function signalItems(status) {
  const signals = status?.signals ?? {}
  if (signals.enabled !== true) return []
  const items = []
  const p99 = Number(signals.loop?.p99Ms)
  if (Number.isFinite(p99) && p99 >= 200) {
    items.push(
      item({
        key: 'loop-latency',
        severity: 'warn',
        kind: 'advice',
        source: 'signal',
        why: 'loop-latency',
        how: 'plugin-reload',
        value: { p99Ms: Math.round(p99 * 10) / 10 },
      }),
    )
  }
  const total = Number(signals.warnings?.total)
  if (Number.isFinite(total) && total > 0) {
    const byName = signals.warnings?.byName ?? {}
    const top = Object.entries(byName)
      .filter(([, count]) => Number(count) > 0)
      .sort((left, right) => Number(right[1]) - Number(left[1]))[0]
    items.push(
      item({
        key: 'process-warning',
        severity: 'info',
        kind: 'advice',
        source: 'signal',
        why: 'process-warning',
        how: 'plugin-check',
        value: { total, name: top ? top[0] : null, count: top ? Number(top[1]) : null },
      }),
    )
  }
  return items
}

function residentItems(status) {
  const alerts = Array.isArray(status?.residents?.alerts) ? status.residents.alerts : []
  if (alerts.length === 0) return []
  const top = alerts[0]
  return [
    item({
      key: 'resident-growth',
      severity: 'warn',
      kind: 'advice',
      source: 'resident',
      why: 'resident-growth',
      how: 'close-app',
      value: {
        name: top?.name ?? null,
        growthBytes: Number.isFinite(top?.growthBytes) ? top.growthBytes : null,
        spanMs: Number.isFinite(top?.spanMs) ? top.spanMs : null,
        dsh: top?.dsh === true,
        count: alerts.length,
      },
    }),
  ]
}

function rendererItems(renderer) {
  if (renderer?.available !== true) return []
  const bytes = Number(renderer.usedBytes)
  if (!Number.isFinite(bytes) || bytes < 1024 * 1024 * 1024) return []
  return [
    item({
      key: 'renderer-heap',
      severity: bytes >= 2 * 1024 * 1024 * 1024 ? 'warn' : 'info',
      kind: 'advice',
      source: 'renderer',
      why: 'renderer-heap',
      how: 'renderer-reload',
      value: { usedBytes: bytes, limitBytes: Number.isFinite(renderer.limitBytes) ? renderer.limitBytes : null },
    }),
  ]
}

export function buildAdvice({ status = {}, renderer = null } = {}) {
  const thresholds = status?.config?.thresholds ?? null
  const all = [
    ...pressureItems(status, thresholds),
    ...heapItems(status),
    ...pagefileItems(status?.system),
    ...crashItems(status),
    ...pluginItems(status?.plugins),
    ...residentItems(status),
    ...signalItems(status),
    ...rendererItems(renderer),
    ...gateItems(status),
  ]
  const seen = new Set()
  const unique = []
  for (const entry of all) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    unique.push(entry)
  }
  unique.sort((left, right) => {
    const rank = (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
    if (rank !== 0) return rank
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
  const items = unique.slice(0, ADVICE_MAX_ITEMS)
  return {
    items,
    total: unique.length,
    truncated: unique.length > items.length,
    // Counted separately so the card can say "3 条建议，其中 1 条是可执行动作"
    // without re-deriving it from the strings.
    actionCount: items.filter((entry) => entry.kind === 'action').length,
  }
}
