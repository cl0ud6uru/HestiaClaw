import { readFileSync, writeFileSync } from 'node:fs'

export function registerMemoryTools(registry, memoryPath) {
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
      writeFileSync(memoryPath, String(content), 'utf8')
      return 'MEMORY.md updated successfully.'
    },
    { source: 'builtin', kind: 'write', risk: 'medium', requiresApproval: true },
  )
}
