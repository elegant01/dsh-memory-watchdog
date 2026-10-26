#!/usr/bin/env node
/**
 * 打开/关闭宿主模块热重载对本插件的监听（照 dsh-codearts 的做法）。
 *
 * 改的是 profile 的 cordis.patch.yml：给 @deepseek-ai/dsh-hmr 写一条覆盖行，
 * config 必须同时给全 root 与 ignored —— patch 是整份 config 替换而不是字段合并，
 * 而 ignored 的默认值里有一条排除 node_modules 的 glob，正好把插件目录排掉。
 *
 * 写入一律无 BOM（带 BOM 的 patch 会让宿主解析炸掉）、先备份、幂等。
 * 别的插件已经写在 root 里的条目会保留。
 *
 * 用法：node scripts/hmr.mjs on|off|status [profileDir]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertNoBom, defaultProfileDir } from './deploy.mjs'

const BLOCK_HEAD = '- id: hmr'
const MARKER = '# managed-by: dsh-memory-watchdog'
const MANAGED_BY = 'dsh-memory-watchdog'

function rootLine(packageName) {
  return `      - node_modules/${packageName}`
}

function ourRootLine(text) {
  return rootLine(MANAGED_BY)
}

/** 把 patch 文件切成顶层块：每块以 `- ` 开头。 */
function splitBlocks(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let header = []
  let current = null
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current) blocks.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    } else {
      header.push(line)
    }
  }
  if (current) blocks.push(current)
  const trailing = blocks.length > 0 ? [] : []
  return { header, blocks, trailing }
}

function render({ header, blocks }) {
  const out = [...header]
  for (const block of blocks) out.push(...block)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimStart()
}

/** 取 `config.root:` 小节里的条目（不能顺带把 ignored 的 glob 当成 root）。 */
function rootEntries(block) {
  const out = []
  let section = null
  for (const line of block) {
    const key = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (key) {
      section = key[1]
      continue
    }
    const item = /^\s{6}- (.+)$/.exec(line)
    if (item && section === 'root') out.push(item[1])
  }
  return out
}

function isHmrBlock(block) {
  return block[0]?.startsWith(BLOCK_HEAD) && block.some((line) => /dsh-hmr/.test(line))
}

function blockConfigLines(roots, ignored) {
  const lines = [
    BLOCK_HEAD,
    `  name: '@deepseek-ai/dsh-hmr'`,
    '  disabled: false',
    `  config: ${MARKER}`,
    '    root:',
  ]
  for (const root of roots) lines.push(`      - ${root}`)
  if (roots.length === 0) lines.push('      []')
  lines.push('    ignored: []')
  return lines
}

function otherRoots(blocks) {
  const found = []
  for (const block of blocks) {
    if (!isHmrBlock(block)) continue
    for (const root of rootEntries(block)) {
      if (root !== `node_modules/${MANAGED_BY}`) found.push(root)
    }
  }
  return [...new Set(found)]
}

export function applyHmr({ profileDir, action }) {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) throw new Error(`patch 文件不存在: ${path}`)
  assertNoBom(path)
  const original = readFileSync(path, 'utf8')
  const { header, blocks } = splitBlocks(original)

  if (action === 'status') {
    const hmr = blocks.find(isHmrBlock)
    if (!hmr) return { changed: false, state: 'no hmr block', roots: [] }
    const roots = rootEntries(hmr)
    return { changed: false, state: roots.includes(`node_modules/${MANAGED_BY}`) ? 'watching' : 'not watching us', roots }
  }

  const others = otherRoots(blocks)
  const kept = blocks.filter((block) => !isHmrBlock(block))
  let next
  if (action === 'on') {
    const roots = [...others, `node_modules/${MANAGED_BY}`]
    kept.push(blockConfigLines(roots, []))
    next = render({ header, blocks: kept })
  } else if (action === 'off') {
    next = others.length > 0 ? render({ header, blocks: [...kept, blockConfigLines(others, [])] }) : render({ header, blocks: kept })
  } else {
    throw new Error(`未知动作: ${action}`)
  }

  if (next.trimEnd() === original.trimEnd()) {
    return { changed: false, state: 'already', path }
  }
  const stamp = Date.now()
  const backupPath = `${path}.bak-${MANAGED_BY}-${stamp}`
  copyFileSync(path, backupPath)
  writeFileSync(path, `${next.trimEnd()}\n`, 'utf8')
  assertNoBom(path)
  return { changed: true, path, backup: backupPath, action }
}

function main(argv) {
  const action = argv[0] ?? 'status'
  const profileDir = argv[1] ?? defaultProfileDir()
  try {
    const result = applyHmr({ profileDir, action })
    if (action === 'status') console.log(`hmr: ${result.state}${result.roots.length ? ` (root: ${result.roots.join(', ')})` : ''}`)
    else if (!result.changed) console.log('· patch 无需改动')
    else console.log(`✓ ${action} 已写入 ${result.path}\n  备份: ${result.backup}`)
    if (action === 'on' && result.changed) console.log('  首次启用可能需要重启一次 DSH 让监听生效。')
    if (action === 'off' && result.changed) console.log('  开着监听时别用插件管理器/npm 升级本插件，现在可以了。')
  } catch (error) {
    console.error(`hmr 失败: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))

