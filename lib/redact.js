import { capText } from './util.js'

/**
 * Redaction for anything that leaves the machine. A diagnostic bundle is the
 * only export that can carry user-machine detail off this computer, so the
 * rules are deliberately blunt: strip the home directory out of every path and
 * shorten session ids. Nothing here guesses; a path either matches a known
 * home layout or it is left alone for a human to see.
 */

// `C:\Users\<name>` / `C:/Users/<name>`, `/Users/<name>`, `/home/<name>`.
// The name segment stops at a separator so only the profile root is replaced.
const HOME_PATTERNS = [
  { pattern: /([A-Za-z]):[\\/]+Users[\\/]+[^\\/\s"'<>|*?]+/gi, replacement: '~' },
  { pattern: /\/Users\/[^/\s"'<>|*?]+/gi, replacement: '~' },
  { pattern: /\/home\/[^/\s"'<>|*?]+/gi, replacement: '~' },
]

const SESSION_KEYS = new Set(['sessionid', 'session', 'parentsessionid', 'childsessionid'])
const ID_VISIBLE_CHARS = 8

/**
 * Replaces the user profile root inside a string with `~`. `C:\Users\me\.dsh`
 * becomes `~\.dsh`, `/home/me/x` becomes `~/x`. Text without a home root is
 * returned unchanged, so ordinary package names and drive letters survive.
 */
export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let text = value
  for (const rule of HOME_PATTERNS) text = text.replace(rule.pattern, rule.replacement)
  return text
}

/**
 * Session identifiers are stable handles into someone's history. Keeping the
 * first few characters is enough to correlate two lines of the same bundle
 * without shipping a usable id.
 */
export function redactId(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value.length <= ID_VISIBLE_CHARS) return value
  return value.slice(0, ID_VISIBLE_CHARS) + '...'
}

/**
 * Deep redaction of a whole payload before it is serialised. Object keys are
 * kept as-is (they are ours, not the user's) and only values are rewritten.
 * Depth is bounded so a cyclic or absurdly nested value can never hang the
 * host; anything past the limit collapses to a placeholder.
 */
export function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(capText(value, 4000))
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object') return String(value)
  if (depth >= 8) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 400).map((item) => redactValue(item, depth + 1))
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (SESSION_KEYS.has(key.toLowerCase())) {
      output[key] = typeof item === 'string' ? redactId(item) : redactValue(item, depth + 1)
      continue
    }
    output[key] = redactValue(item, depth + 1)
  }
  return output
}
