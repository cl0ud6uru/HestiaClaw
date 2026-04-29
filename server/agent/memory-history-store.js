import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_ENTRIES = 50

// Per-path async mutex — prevents interleaved reads/writes on the same file
const locks = new Map()

function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise(r => { release = r })
  locks.set(key, prev.then(() => gate))
  return prev.then(async () => {
    try { return await fn() } finally { release() }
  })
}

async function loadHistoryData(historyPath) {
  try {
    return JSON.parse(await readFile(historyPath, 'utf8'))
  } catch {
    return { history: [] }
  }
}

// Atomically: read MEMORY.md → write new content → append history entry.
// All three steps are serialised per memoryPath so concurrent requests
// cannot produce history entries with a stale "previousContent".
export async function writeMemory(memoryPath, historyPath, { newContent, source, episodesDeleted = [] }) {
  return withLock(memoryPath, async () => {
    let previousContent = ''
    try { previousContent = await readFile(memoryPath, 'utf8') } catch { /* file not yet created */ }
    await writeFile(memoryPath, newContent, 'utf8')
    if (historyPath) {
      const data = await loadHistoryData(historyPath)
      const entry = {
        id: randomUUID(),
        changedAt: new Date().toISOString(),
        source,
        previousContent,
        newContent,
        episodesDeleted,
      }
      data.history.unshift(entry)
      if (data.history.length > MAX_ENTRIES) data.history.length = MAX_ENTRIES
      await mkdir(dirname(historyPath), { recursive: true })
      await writeFile(historyPath, JSON.stringify(data, null, 2), 'utf8')
    }
  })
}

export async function loadHistory(historyPath) {
  return loadHistoryData(historyPath)
}
