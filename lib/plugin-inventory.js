import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Normalizes a script URL or filesystem path into a comparable string:
 * absolute, forward slashes, lowercase. Returns null for values that carry no
 * file identity (anonymous eval, empty frames).
 */
export function scriptPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let value = raw
  if (value.startsWith('node:')) return null
  if (value.startsWith('file://')) {
    value = value.slice('file://'.length)
    // file:///F:/x -> /F:/x; file:///home/u/x stays /home/u/x
    if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
    try {
      value = decodeURIComponent(value)
    } catch {}
  }
  if (value.endsWith('(native)') || value.startsWith('(')) return null
  value = value.replace(/\\/g, '/')
  if (!value.startsWith('/') && !/^[A-Za-z]:\//.test(value)) return null
  return value.toLowerCase()
}

function withSlash(directory) {
  const normalized = String(directory).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.length === 0 ? null : normalized + '/'
}

/** Directory of this package's own installation, or null when running from source. */
export function ownDirectory() {
  try {
    const self = fileURLToPath(import.meta.url).replace(/\\/g, '/')
    const index = self.toLowerCase().lastIndexOf('/node_modules/')
    if (index === -1) return null
    const rest = self.slice(index + '/node_modules/'.length)
    const parts = rest.split('/')
    const packageParts = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
    if (packageParts.length === 0 || packageParts.some((part) => part.length === 0)) return null
    return self.slice(0, index) + '/node_modules/' + packageParts.join('/')
  } catch {
    return null
  }
}

/** Profile directory (`.../profiles/desktop`) inferred from an installed package path. */
export function profileDirectoryOf(packageDirectory) {
  if (typeof packageDirectory !== 'string') return null
  const normalized = packageDirectory.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.toLowerCase().lastIndexOf('/node_modules/')
  if (index === -1) return null
  return normalized.slice(0, index)
}

async function readPackageJson(directory) {
  try {
    const raw = await readFile(join(directory, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function pluginKey(name) {
  return typeof name === 'string' && name.length > 0 ? name : null
}

/**
 * Lists the DSH plugins installed in a profile's node_modules. A package counts
 * as a plugin when its package.json carries a `dsh` marker, which is how the
 * host itself recognises them.
 */
export async function scanInstalledPlugins(profileDir, { ownPackage = null } = {}) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) return []
  const modulesDir = join(profileDir, 'node_modules')
  let names
  try {
    names = await readdir(modulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = await readdir(join(modulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.isDirectory()) candidates.push(entry.name + '/' + child.name)
      }
      continue
    }
    candidates.push(entry.name)
  }

  const plugins = []
  for (const key of candidates) {
    const directory = join(modulesDir, key)
    const manifest = await readPackageJson(directory)
    if (manifest === null) continue
    if (manifest.dsh === undefined || manifest.dsh === null || manifest.dsh === false) continue
    const name = pluginKey(manifest.name) ?? key
    if (ownPackage !== null && (name === ownPackage || key === ownPackage)) continue
    plugins.push({
      key: name,
      name,
      kind: 'plugin',
      version: typeof manifest.version === 'string' ? manifest.version : null,
      dir: directory.replace(/\\/g, '/'),
      path: withSlash(directory),
    })
  }
  plugins.sort((left, right) => left.key.localeCompare(right.key))
  return plugins
}

/** Directory list used by the radar to attribute registrations to packages. */
export async function loadPluginInventory({ ownPackage = null } = {}) {
  const ownDir = ownDirectory()
  const profileDir = profileDirectoryOf(ownDir)
  const plugins = await scanInstalledPlugins(profileDir, { ownPackage })
  return {
    ownDir,
    profileDir,
    plugins,
    dirs: plugins.map((plugin) => ({ key: plugin.key, name: plugin.name, kind: plugin.kind, path: plugin.path })),
  }
}