#!/usr/bin/env node
/**
 * 把当前工作树部署进 DSH profile（照 dsh-codearts 的安全语义）。
 *
 * 全部走 fs（二进制复制 / writeFileSync），刻意不用 PowerShell 文本写入：
 * 带 BOM 的 manifest 会让宿主裸 JSON.parse 抛 DesktopHostFatalError 连环崩溃。
 *
 * 同步语义是**原地覆盖**：dsh-hmr 只响应 chokidar 的 change 事件，
 * 删目录重建只会产生 unlink+add，热重载不触发；逐字节相同的文件不动，
 * 免得白刷一次重载。manifest 只在语义变化时才写，写前备份。
 *
 * 用法：node scripts/deploy.mjs [profileDir] [--quiet] [--prune-legacy]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE_NAME = 'dsh-memory-watchdog'
export const LEGACY_PACKAGE_NAME = 'dsh-memory-guard'
export const PACKAGE_ROOT_FILES = [
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.en.md',
  'MARKET.md',
  'INSTALL.md',
  'INSTALL.en.md',
  'DEV.md',
  'CHANGELOG.md',
  'LICENSE',
]

export const SOURCE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function defaultProfileDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(home, '.dsh', 'profiles', 'desktop')
}

export function assertNoBom(path) {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`BOM detected in ${path} — 部署中止，请检查源文件`)
  }
}

/**
 * copyFileSync 会把目标的 mtime 写成源文件的 mtime，原地覆盖后时间戳不变，
 * dsh-hmr 的 change 判定就拿不到信号，所以复制完主动推到当前时刻。
 */
function touchNow(path) {
  const now = new Date()
  utimesSync(path, now, now)
}

function sameBytes(a, b) {
  if (statSync(a).size !== statSync(b).size) return false
  return readFileSync(a).equals(readFileSync(b))
}

function syncTree(src, dst, stats) {
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
  const names = new Set(readdirSync(src))
  for (const name of names) {
    const from = join(src, name)
    const to = join(dst, name)
    if (statSync(from).isDirectory()) {
      syncTree(from, to, stats)
      continue
    }
    if (existsSync(to) && statSync(to).isFile() && sameBytes(from, to)) {
      stats.unchanged += 1
      continue
    }
    const existed = existsSync(to)
    copyFileSync(from, to)
    touchNow(to)
    if (existed) stats.updated += 1
    else stats.added += 1
  }
  for (const name of readdirSync(dst)) {
    if (names.has(name)) continue
    rmSync(join(dst, name), { recursive: true, force: true })
    stats.pruned += 1
  }
}

function backup(path, tag) {
  const dst = `${path}.bak-${tag}-${Date.now()}`
  copyFileSync(path, dst)
  return dst
}

function patchManifest(path, mutate, { optional = false, tag = 'watchdog' } = {}) {
  if (!existsSync(path)) {
    if (optional) return { changed: false, missing: true }
    throw new Error(`manifest 不存在: ${path}`)
  }
  assertNoBom(path)
  const before = JSON.parse(readFileSync(path, 'utf8'))
  const json = JSON.parse(JSON.stringify(before))
  mutate(json)
  if (JSON.stringify(before) === JSON.stringify(json)) return { changed: false }
  const backupPath = backup(path, tag)
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  assertNoBom(path)
  return { changed: true, backup: backupPath }
}

function removeManifestEntry(path, name, { tag = 'watchdog' } = {}) {
  return patchManifest(
    path,
    (json) => {
      if (json.dependencies) delete json.dependencies[name]
      if (json.devDependencies) delete json.devDependencies[name]
      const bundles = json.dsh?.profile?.bundles
      if (Array.isArray(bundles)) {
        json.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
      }
    },
    { optional: true, tag }
  )
}

export function deploy(options = {}) {
  const profileDir = options.profileDir ?? defaultProfileDir()
  const log = options.log ?? ((line) => { if (!options.quiet) console.log(line) })
  const manifest = JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8'))
  const version = manifest.version ?? '0.0.0'
  const srcLib = join(SOURCE_DIR, 'lib')
  if (!existsSync(srcLib)) throw new Error(`找不到 ${srcLib}`)

  log(`→ profile: ${profileDir}`)
  const packageDir = join(profileDir, 'node_modules', PACKAGE_NAME)
  const files = { added: 0, updated: 0, unchanged: 0, pruned: 0 }
  syncTree(srcLib, join(packageDir, 'lib'), files)
  for (const name of PACKAGE_ROOT_FILES) {
    const from = join(SOURCE_DIR, name)
    if (!existsSync(from)) continue
    const to = join(packageDir, name)
    if (existsSync(to) && sameBytes(from, to)) {
      files.unchanged += 1
      continue
    }
    if (!existsSync(packageDir)) mkdirSync(packageDir, { recursive: true })
    const existed = existsSync(to)
    copyFileSync(from, to)
    touchNow(to)
    if (existed) files.updated += 1
    else files.added += 1
  }
  log(`✓ 包本体已同步: ${packageDir} (新增 ${files.added} / 覆盖 ${files.updated} / 未变 ${files.unchanged} / 清理 ${files.pruned})`)
  if (!existsSync(join(packageDir, 'lib', 'client', 'index.js'))) {
    log('⚠ 缺少 lib/client/index.js —— 设置页卡片不会加载')
  }

  const manifests = {}
  manifests.profilePackage = patchManifest(join(profileDir, 'package.json'), (json) => {
    json.dependencies = json.dependencies ?? {}
    json.dependencies[PACKAGE_NAME] = version
    const profile = (json.dsh = json.dsh ?? {}).profile = json.dsh.profile ?? {}
    const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
    if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
    profile.bundles = bundles
  })
  log(manifests.profilePackage.changed ? '✓ profile/package.json dependencies + bundles' : '· profile/package.json 无需改动')

  manifests.packageMap = patchManifest(
    join(profileDir, 'node_modules', '.package-map.json'),
    (json) => {
      json[PACKAGE_NAME] = json[PACKAGE_NAME] ?? { url: `./${PACKAGE_NAME}`, dependencies: { [PACKAGE_NAME]: PACKAGE_NAME } }
      json['.'] = json['.'] ?? { dependencies: {} }
      json['.'].dependencies = json['.'].dependencies ?? {}
      json['.'].dependencies[PACKAGE_NAME] = PACKAGE_NAME
    },
    { optional: true }
  )
  log(manifests.packageMap.missing ? '· .package-map.json 不存在（新版 pnpm 不再写），跳过' : manifests.packageMap.changed ? '✓ .package-map.json' : '· .package-map.json 无需改动')

  manifests.modulesYaml = patchManifest(join(profileDir, 'node_modules', '.modules.yaml'), (json) => {
    json.hoistedLocations = json.hoistedLocations ?? {}
    json.hoistedLocations[`${PACKAGE_NAME}@${version}`] = [`node_modules\\${PACKAGE_NAME}`]
  })
  log(manifests.modulesYaml.changed ? '✓ .modules.yaml hoistedLocations' : '· .modules.yaml 无需改动')

  if (options.pruneLegacy) {
    const profilePackage = join(profileDir, 'package.json')
    const legacyDep = existsSync(profilePackage) && JSON.parse(readFileSync(profilePackage, 'utf8')).dependencies?.[LEGACY_PACKAGE_NAME] !== undefined
    if (legacyDep) {
      manifests.legacyProfile = removeManifestEntry(profilePackage, LEGACY_PACKAGE_NAME)
      manifests.legacyPackageMap = removeManifestEntry(join(profileDir, 'node_modules', '.package-map.json'), LEGACY_PACKAGE_NAME)
      log('✓ 已从 profile 清单里移除旧名 dsh-memory-guard')
    }
    const legacyDir = join(profileDir, 'node_modules', LEGACY_PACKAGE_NAME)
    if (existsSync(legacyDir)) {
      rmSync(legacyDir, { recursive: true, force: true })
      log(`✓ 已删除旧包目录 ${legacyDir}`)
    }
    if (!legacyDep && !existsSync(legacyDir)) log('· 没有旧名 dsh-memory-guard 的痕迹')
  }

  const dirty = files.added + files.updated + files.pruned
  log(dirty === 0 ? '\n· 产物无变化，全部 manifest 无 BOM。' : '\n🎉 部署完成，全部 manifest 无 BOM。')
  if (dirty > 0 && !options.quiet) {
    log('  已开 hmr:on 时宿主插件会被热重载，客户端产物由 dsh-client-hmr 送进浏览器；否则重启 DSH 生效。')
  }
  return { profileDir, packageDir, version, files, manifests }
}

function main(argv) {
  const profileArg = argv.find((arg) => !arg.startsWith('--'))
  try {
    deploy({ profileDir: profileArg ?? defaultProfileDir(), quiet: argv.includes('--quiet'), pruneLegacy: argv.includes('--prune-legacy') })
    if (!argv.includes('--quiet')) console.log('未开 hmr 模块监听时，重启 DSH 生效。')
  } catch (error) {
    console.error(`部署失败: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
