import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendHistory } from '../../memory-history-store.js'

export function registerMemoryTools(registry, memoryPath, historyPath = null) {
  registry.register(
    'read_memory',
    'Read the current contents of the pinned MEMORY.md file — your confirmed high-confidence long-term memories.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      try {
        return readFileSync(memoryPath, 'utf8')
      } catch {
        return '(No pinned memory file found.)'
      }
    },
    { source: 'builtin', kind: 'read', risk: 'low' },
  )

  registry.register(
    'write_memory',
    'Overwrite the pinned MEMORY.md file with updated content. Use this when a confirmed durable fact changes or needs correction. Only for high-confidence, genuinely important updates — not every turn.',
    {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Complete markdown content to write to MEMORY.md' },
      },
      required: ['content'],
    },
    async ({ content }) => {
      let previousContent = ''
      try { previousContent = readFileSync(memoryPath, 'utf8') } catch { /* file may not exist */ }
      writeFileSync(memoryPath, String(content), 'utf8')
      if (historyPath) {
        appendHistory(historyPath, { source: 'agent', previousContent, newContent: String(content) })
      }
      return 'MEMORY.md updated successfully.'
    },
    { source: 'builtin', kind: 'write', risk: 'medium', requiresApproval: true },
  )
}

export function registerDailyNoteTool(registry, notesDir) {
  registry.register(
    'write_daily_note',
    "Append a timestamped entry to today's daily note log. Use this to record what happened, observations, completed tasks, or anything worth remembering episodically. Today's and yesterday's notes are injected into your context each turn.",
    {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The note entry to append. Plain text or markdown.' },
      },
      required: ['entry'],
    },
    async ({ entry }) => {
      const now = new Date()
      const datestamp = now.toISOString().slice(0, 10)
      const timestamp = now.toISOString().slice(11, 19)
      const noteFile = join(notesDir, `${datestamp}.md`)
      mkdirSync(notesDir, { recursive: true })
      let existing = ''
      try { existing = readFileSync(noteFile, 'utf8') } catch { /* file may not exist yet */ }
      const sep = existing && !existing.endsWith('\n') ? '\n' : ''
      writeFileSync(noteFile, existing + `${sep}- [${timestamp}] ${String(entry).trim()}\n`, 'utf8')
      return `Daily note appended for ${datestamp}.`
    },
    { source: 'builtin', kind: 'write', risk: 'low', requiresApproval: false },
  )
}
