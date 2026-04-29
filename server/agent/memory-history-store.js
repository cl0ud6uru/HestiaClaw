import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const MAX_ENTRIES = 50

function load(historyPath) {
  try {
    return JSON.parse(readFileSync(historyPath, 'utf8'))
  } catch {
    return { history: [] }
  }
}

export function appendHistory(historyPath, { source, previousContent, newContent, episodesDeleted = [] }) {
  const data = load(historyPath)
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
  writeFileSync(historyPath, JSON.stringify(data, null, 2), 'utf8')
  return entry
}

export function loadHistory(historyPath) {
  return load(historyPath)
}
