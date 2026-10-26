import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function capText(value, max = 500) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export async function readJsonFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'ENOENT', error: 'not found' }
    return { ok: false, code: error?.code ?? 'READ_ERROR', error: safeErrorMessage(error) }
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
