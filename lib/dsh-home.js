import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function resolveDshHome(configured, env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME : undefined
  const base = configured === undefined || configured === null ? (fromEnv ?? join(homedir(), '.dsh')) : configured
  return resolve(expandHomePath(base))
}

export function guardDirectory(env = process.env) {
  return join(resolveDshHome(undefined, env), 'commit-guard')
}
