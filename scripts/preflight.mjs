#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(here, '..')

const REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/constants.js',
  'lib/config.js',
  'lib/thresholds.js',
  'lib/pressure.js',
  'lib/runtime.js',
  'lib/routes.js',
  'lib/store.js',
  'lib/attribution.js',
  'lib/resident-watch.js',
  'lib/system-info.js',
  'lib/crash-history.js',
  'lib/resume.js',
  'lib/client/index.js',
  'lib/resources/collector.ps1',
  'lib/resources/jobcheck.ps1',
  'lib/resources/escape.ps1',
  'lib/resources/relaunch.ps1',
  'lib/resources/inspect.ps1',
  'lib/resources/freeze.ps1',
  'lib/resources/terminate.ps1',
  'lib/resources/top.ps1',
  'lib/resources/system-info.ps1',
  'lib/resources/crash-history.ps1',
  'lib/resources/helper.mjs',
  'README.md',
  'README.en.md',
  'MARKET.md',
  'INSTALL.md',
  'INSTALL.en.md',
  'DEV.md',
  'CHANGELOG.md',
  'LICENSE',
  'scripts/deploy.mjs',
  'scripts/hmr.mjs',
]

const REQUIRED_PS1 = [
  'lib/resources/collector.ps1',
  'lib/resources/jobcheck.ps1',
  'lib/resources/escape.ps1',
  'lib/resources/relaunch.ps1',
  'lib/resources/inspect.ps1',
  'lib/resources/freeze.ps1',
  'lib/resources/terminate.ps1',
  'lib/resources/top.ps1',
  'lib/resources/system-info.ps1',
  'lib/resources/crash-history.ps1',
]

const FORBIDDEN_SOURCE_PATTERNS = [
  { pattern: /taskkill\s+\/IM/i, reason: 'broad taskkill /IM is forbidden' },
  { pattern: /shell\s*:\s*true/, reason: 'child processes must use shell: false' },
  { pattern: /Get-CimInstance/i, reason: 'WMI/CIM collection is forbidden' },
  { pattern: /Invoke-CimMethod/i, reason: 'WMI/CIM collection is forbidden' },
  { pattern: /\bwmic\b/i, reason: 'WMIC is forbidden' },
  { pattern: /Set-ExecutionPolicy/i, reason: 'persistent execution-policy changes are forbidden' },
  { pattern: /ExecutionPolicy\s+Unrestricted/i, reason: 'unrestricted execution policy is forbidden' },
  { pattern: /CreateProcessAsUser|CreateProcessWithLogonW/i, reason: 'external process-creation proxies are forbidden' },
  { pattern: /Stop-Process\s+-Name/i, reason: 'kill-by-image-name is forbidden' },
  { pattern: /Remove-Item\s+-Recurse/i, reason: 'recursive deletion is forbidden' },
]

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.probe') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, out)
    else out.push(path)
  }
  return out
}

function check(list, name, ok, detail = null) {
  list.push({ name, ok: ok === true, detail })
}

export async function runPreflight({ root = defaultRoot } = {}) {
  const checks = []

  for (const file of REQUIRED_FILES) {
    check(checks, `file:${file}`, await exists(join(root, file)), 'required delivery file is missing')
  }

  let manifest = null
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    check(checks, 'manifest:json', true)
  } catch (error) {
    check(checks, 'manifest:json', false, String(error.message ?? error))
    return { ok: false, checks }
  }

  check(checks, 'manifest:name', manifest.name === 'dsh-memory-watchdog', String(manifest.name))
  check(checks, 'manifest:type', manifest.type === 'module', String(manifest.type))
  check(checks, 'manifest:main', manifest.main === 'lib/index.js', String(manifest.main))
  check(checks, 'manifest:exports:dot', manifest.exports?.['.'] === './lib/index.js', JSON.stringify(manifest.exports?.['.'] ?? null))
  check(checks, 'manifest:exports:client', manifest.exports?.['./client'] === './lib/client/index.js', JSON.stringify(manifest.exports?.['./client'] ?? null))
  check(checks, 'manifest:exports:patch', manifest.exports?.['./cordis.patch.yml'] === './cordis.patch.yml', JSON.stringify(manifest.exports?.['./cordis.patch.yml'] ?? null))
  check(checks, 'manifest:dsh:patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch))
  check(checks, 'manifest:dsh:client-platform', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
  check(checks, 'manifest:engines:dsh', manifest.engines?.dsh === '>=0.2.0-rc.1 <0.3', String(manifest.engines?.dsh))
  check(checks, 'manifest:no-dsh-peer', manifest.peerDependencies === undefined || manifest.peerDependencies?.dsh === undefined)
  const files = Array.isArray(manifest.files) ? manifest.files : []
  check(checks, 'manifest:files:lib', files.includes('lib'), JSON.stringify(files))
  for (const required of ['cordis.patch.yml', 'README.md', 'README.en.md', 'MARKET.md', 'INSTALL.md', 'INSTALL.en.md', 'DEV.md', 'CHANGELOG.md', 'LICENSE']) {
    check(checks, `manifest:files:${required}`, files.includes(required), JSON.stringify(files))
  }
  check(checks, 'manifest:no-install-script', manifest.scripts?.preinstall === undefined && manifest.scripts?.postinstall === undefined && manifest.scripts?.install === undefined)

  const patchPath = join(root, 'cordis.patch.yml')
  if (await exists(patchPath)) {
    const patch = await readFile(patchPath, 'utf8')
    check(checks, 'patch:insert', /-\s*insert:/.test(patch), patch.trim())
    check(checks, 'patch:name', /name:\s*dsh-memory-watchdog/.test(patch), patch.trim())
  }

  const indexPath = join(root, 'lib/index.js')
  if (await exists(indexPath)) {
    const source = await readFile(indexPath, 'utf8')
    check(checks, 'config:volatile-default-false', /\.default\(false\)\s*\.volatile\(\)/.test(source))
    check(checks, 'config:autoRestart', /autoRestart/.test(source))
    check(checks, 'config:resume-default-false', /resumeAfterCrash:\s*z[\s\S]{0,40}\.default\(false\)/.test(source))
    for (const field of ['warningPct', 'criticalPct', 'criticalAvailMb', 'confirmSamples', 'cooldownMinutes', 'restartGatePct', 'residentGrowMb']) {
      check(checks, `config:threshold-field:${field}`, new RegExp(`${field}:\\s*z[\\s\\S]{0,16}\\.number\\(\\)`).test(source), field)
    }
  }

  const thresholdsPath = join(root, 'lib/thresholds.js')
  if (await exists(thresholdsPath)) {
    const source = await readFile(thresholdsPath, 'utf8')
    check(checks, 'thresholds:clamp', /Math\.min\(max, Math\.max\(min, number\)\)/.test(source))
    check(checks, 'thresholds:critical-above-warning', /warningPct \+ 1/.test(source))
  }

  const runtimePath = join(root, 'lib/runtime.js')
  if (await exists(runtimePath)) {
    const source = await readFile(runtimePath, 'utf8')
    check(checks, 'runtime:thresholds-resolved', /resolveThresholds\(rawConfig\)/.test(source))
    check(checks, 'runtime:cooldown-configurable', /this\.thresholds\.cooldownMs/.test(source) && !/COOLDOWN_MS/.test(source))
    check(checks, 'runtime:gate-armed', /evaluateRestartGate|this\.restartGate\(\)/.test(source))
    check(checks, 'runtime:probes-failable', /refreshAttribution/.test(source) && /refreshSystemInfo/.test(source) && /refreshCrashHistory/.test(source))
    check(checks, 'runtime:resume-scheduled', /startResumeScheduler/.test(source) && /stopResumeScheduler/.test(source))
  }

  const resumePath = join(root, 'lib/resume.js')
  if (await exists(resumePath)) {
    const source = await readFile(resumePath, 'utf8')
    check(checks, 'resume:aborted-guard', /resume\.user-canceled/.test(source) && /'aborted'/.test(source))
    check(checks, 'resume:idempotent-request-id', /memory-watchdog-resume-\$\{sessionId\}-\$\{turn\}\$\{suffix\}/.test(source))
    check(checks, 'resume:ledger-before-prompt', /await this\.writeLedger\(\)[\s\S]{0,400}controller\.prompt/.test(source))
    check(checks, 'resume:child-anti-loop', /childHandled/.test(source))
  }

  const residentPath = join(root, 'lib/resident-watch.js')
  if (await exists(residentPath)) {
    const source = await readFile(residentPath, 'utf8')
    check(checks, 'resident:warn-only', !/kill|terminate|taskkill|spawn/i.test(source), 'the growth watch must stay read-only')
    check(checks, 'resident:floor', /ATTRIBUTION_MIN_TRACK_BYTES/.test(source))
    check(checks, 'resident:rebaseline', /baseBytes: bytes/.test(source))
  }

  const topScript = join(root, 'lib/resources/top.ps1')
  if (await exists(topScript)) {
    const source = await readFile(topScript, 'utf8')
    check(checks, 'top:exe-path', /QueryFullProcessImageNameW/.test(source))
    check(checks, 'top:age', /GetProcessTimes/.test(source))
    check(checks, 'top:no-handle-leak', /finally\s*\{[\s\S]{0,80}CloseHandle/.test(source))
  }

  const routesPath = join(root, 'lib/routes.js')
  if (await exists(routesPath)) {
    const source = await readFile(routesPath, 'utf8')
    check(checks, 'routes:events', source.includes('/api/memory-watchdog.events') && /methods:\s*\['GET'\]/.test(source))
    check(checks, 'routes:resume-post', source.includes('/api/memory-watchdog.resume') && /resume-disabled/.test(source))
  }

  const clientPath = join(root, 'lib/client/index.js')
  if (await exists(clientPath)) {
    const client = await readFile(clientPath, 'utf8')
    check(checks, 'client:loader-id', /id:\s*"dsh-memory-watchdog"/.test(client))
    check(checks, 'client:bundle-config-key', /key:\s*"dsh-memory-watchdog"/.test(client))
    check(checks, 'client:status-route', client.includes('/api/memory-watchdog.status'))
    check(checks, 'client:cancel-route', client.includes('/api/memory-watchdog.cancel'))
    check(checks, 'client:disclosure', client.includes('disclosure1') && client.includes('disclosure5'))
    check(checks, 'client:disclosure-gate', client.includes('disclosure6') && client.includes('disclosure7'))
    check(checks, 'client:events-route', client.includes('/api/memory-watchdog.events'))
    check(checks, 'client:resume-route', client.includes('/api/memory-watchdog.resume'))
    for (const section of ['attributionTitle', 'residentGrowLabel', 'systemTitle', 'crashTitle', 'historyTitle', 'resumeTitle', 'copyDiagnostics']) {
      check(checks, `client:section:${section}`, client.includes(section), section)
    }
    check(checks, 'client:read-only', !/-HostPid|-MainPid|scriptPath|spawnProcess|-File\s|taskkill|Stop-Process/i.test(client))
  }

  for (const script of ['lib/attribution.js', 'lib/system-info.js', 'lib/crash-history.js']) {
    const path = join(root, script)
    if (!(await exists(path))) continue
    const source = await readFile(path, 'utf8')
    check(checks, `probe:no-kill:${script}`, !/Stop-Process|taskkill|\.kill\(/i.test(source), script)
    check(checks, `probe:read-only:${script}`, !/Set-ItemProperty|New-ItemProperty|Remove-Item/i.test(source), script)
  }

  for (const script of REQUIRED_PS1) {
    const path = join(root, script)
    if (!(await exists(path))) continue
    const bytes = await readFile(path)
    const text = bytes.toString('utf8')
    const nonAscii = [...bytes].some((byte) => byte > 0x7f)
    check(checks, `ps1:ascii:${relative(root, path).split(sep).join('/')}`, !nonAscii, 'PowerShell resources must stay ASCII')
    check(checks, `ps1:params:${relative(root, path).split(sep).join('/')}`, /param\s*\(/i.test(text))
    check(checks, `ps1:encoding:${relative(root, path).split(sep).join('/')}`, text.includes('[Console]::OutputEncoding'))
  }

  const sourceFiles = (await walk(join(root, 'lib'))).filter((file) => file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.ps1'))
  for (const file of sourceFiles) {
    const text = await readFile(file, 'utf8')
    for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
      check(checks, `source:forbidden:${rule.pattern.source}:${relative(root, file).split(sep).join('/')}`, !rule.pattern.test(text), rule.reason)
    }
  }

  const deployPath = join(root, 'scripts/deploy.mjs')
  if (await exists(deployPath)) {
    const source = await readFile(deployPath, 'utf8')
    check(checks, 'deploy:in-place-overwrite', /copyFileSync/.test(source) && !/rmSync\(\s*packageDir/.test(source), 'hmr only reacts to change events, so the sync must overwrite in place')
    check(checks, 'deploy:bom-guard', /assertNoBom/.test(source))
    check(checks, 'deploy:manifest-backup', /backup\(/.test(source))
    check(checks, 'deploy:exact-version-pin', /json\.dependencies\[PACKAGE_NAME\] = version/.test(source))
  }

  const hmrPath = join(root, 'scripts/hmr.mjs')
  if (await exists(hmrPath)) {
    const source = await readFile(hmrPath, 'utf8')
    check(checks, 'hmr:ignored-must-be-empty', /ignored: \[\]/.test(source), 'the default ignored glob excludes node_modules and would swallow the plugin')
    check(checks, 'hmr:keeps-other-roots', /otherRoots/.test(source))
    check(checks, 'hmr:no-set-content', !/Set-Content|Out-File/i.test(source))
  }

  const releaseWorkflow = join(root, '.github/workflows/release.yml')
  if (await exists(releaseWorkflow)) {
    const source = await readFile(releaseWorkflow, 'utf8')
    check(checks, 'release:oidc-provenance', /id-token: write/.test(source) && /npm publish --provenance/.test(source))
    check(checks, 'release:no-registry-url', !/registry-url:/.test(source), 'a generated authenticated .npmrc makes npm take the token path instead of OIDC (ENEEDAUTH)')
    check(checks, 'release:no-committed-token', !/NPM_TOKEN/.test(source), 'publishing must not depend on a committed token')
    check(checks, 'release:node-with-oidc-npm', /node-version:\s*'2[4-9]'/.test(source), 'npm >= 11 is required for trusted publishing')
  }

  const changelogPath = join(root, 'CHANGELOG.md')
  if (await exists(changelogPath)) {
    const source = await readFile(changelogPath, 'utf8')
    check(checks, 'changelog:documents-current-version', source.includes(manifest.version), `no entry for ${manifest.version}`)
  }

  for (const scriptDir of ['scripts']) {
    const dir = join(root, scriptDir)
    if (!(await exists(dir))) continue
    const scan = (await walk(dir)).filter((entry) => /\.(mjs|js|ps1)$/.test(entry) && basename(entry) !== 'preflight.mjs')
    for (const file of scan) {
      const text = await readFile(file, 'utf8')
      for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
        check(checks, `source:forbidden:${rule.pattern.source}:${relative(root, file).split(sep).join('/')}`, !rule.pattern.test(text), rule.reason)
      }
    }
  }

  const clientAbsent = checks.filter((entry) => entry.name.startsWith('client:') && !entry.ok)
  check(checks, 'client:complete', clientAbsent.length === 0)

  return { ok: checks.every((entry) => entry.ok), checks }
}

async function main() {
  const result = await runPreflight()
  const failed = result.checks.filter((entry) => !entry.ok)
  for (const entry of result.checks) {
    if (!entry.ok) console.error(`FAIL ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  if (failed.length === 0) {
    console.log(`preflight OK (${result.checks.length} checks)`)
    process.exit(0)
  }
  console.error(`preflight FAILED (${failed.length}/${result.checks.length} checks)`)
  process.exit(1)
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) main().catch((error) => {
  console.error(error)
  process.exit(1)
})
