import { writeFileSync } from 'node:fs'

const CONSOLIDATION_PROMPT = `You are a memory curator for an AI assistant called Hestia.
You will receive a list of Graphiti memory episodes from two groups: hestia_user (personal facts) and hestia_home (home/device facts).

Your task:
1. Identify duplicate or superseded episodes that should be deleted (list their UUIDs).
2. Produce a clean MEMORY.md with the most important durable facts.

Rules for deletion:
- Delete duplicates — keep the most recent or most specific one.
- Delete low-value fragments: transient states, tool chatter, one-off errors, raw cleanup narration.
- Delete clearly superseded facts where a newer episode contradicts and replaces the old one.
- Never delete the only copy of a durable fact.

Rules for MEMORY.md:
- Only include genuinely durable, high-confidence facts: people, devices, rooms, stable preferences, ongoing projects, important routines, significant events.
- Keep it concise. One bullet per fact. No speculation.
- Group under these headings (omit a heading if empty):
  ## People
  ## Home & Devices
  ## Preferences
  ## Ongoing Projects
  ## Routines & Automations

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "episodes_to_delete": ["uuid1", "uuid2"],
  "memory_md_content": "# Hestia Memory\\n\\n..."
}`

export async function runConsolidation({ provider, registry, memoryPath }) {
  console.log('[consolidation] Starting memory consolidation...')

  // Fetch recent episodes from both groups
  let userEpisodes = ''
  let homeEpisodes = ''

  try {
    userEpisodes = await registry.execute('graphiti__get_episodes', { group_id: 'hestia_user', last_n: 100 })
  } catch (err) {
    console.warn('[consolidation] Could not fetch hestia_user episodes:', err.message)
  }

  try {
    homeEpisodes = await registry.execute('graphiti__get_episodes', { group_id: 'hestia_home', last_n: 100 })
  } catch (err) {
    console.warn('[consolidation] Could not fetch hestia_home episodes:', err.message)
  }

  if (!userEpisodes && !homeEpisodes) {
    console.warn('[consolidation] No episodes retrieved — skipping.')
    return { episodesDeleted: 0, memoryUpdated: false }
  }

  const episodeContent = [
    userEpisodes ? `=== hestia_user episodes ===\n${userEpisodes}` : '',
    homeEpisodes ? `=== hestia_home episodes ===\n${homeEpisodes}` : '',
  ].filter(Boolean).join('\n\n')

  const messages = [
    {
      role: 'user',
      content: `Here are the current Graphiti memory episodes:\n\n${episodeContent}\n\nAnalyze these and return the consolidation JSON.`,
    },
  ]

  let responseText
  try {
    responseText = await provider.generate(messages, { system: CONSOLIDATION_PROMPT })
  } catch (err) {
    console.error('[consolidation] LLM call failed:', err.message)
    return { episodesDeleted: 0, memoryUpdated: false }
  }

  let plan
  try {
    // Strip any accidental markdown fences before parsing
    const cleaned = responseText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
    plan = JSON.parse(cleaned)
  } catch (err) {
    console.error('[consolidation] Failed to parse LLM response as JSON:', err.message)
    console.error('[consolidation] Raw response:', responseText.slice(0, 500))
    return { episodesDeleted: 0, memoryUpdated: false }
  }

  let episodesDeleted = 0
  const toDelete = Array.isArray(plan.episodes_to_delete) ? plan.episodes_to_delete : []
  for (const uuid of toDelete) {
    try {
      await registry.execute('graphiti__delete_episode', { episode_id: String(uuid) })
      episodesDeleted++
    } catch (err) {
      console.warn(`[consolidation] Could not delete episode ${uuid}:`, err.message)
    }
  }

  let memoryUpdated = false
  if (typeof plan.memory_md_content === 'string' && plan.memory_md_content.trim()) {
    try {
      writeFileSync(memoryPath, plan.memory_md_content, 'utf8')
      memoryUpdated = true
    } catch (err) {
      console.error('[consolidation] Failed to write MEMORY.md:', err.message)
    }
  }

  console.log(`[consolidation] Done — deleted ${episodesDeleted} episode(s), MEMORY.md updated: ${memoryUpdated}`)
  return { episodesDeleted, memoryUpdated }
}
