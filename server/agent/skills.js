import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: text.trim() }

  const meta = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const raw = line.slice(colonIdx + 1).trim()
    if (raw === 'true') meta[key] = true
    else if (raw === 'false') meta[key] = false
    else meta[key] = raw
  }

  return { meta, body: match[2].trim() }
}

export async function loadSkills(skillsDir) {
  const skills = []

  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return skills
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')

    try {
      const text = await readFile(skillFile, 'utf8')
      const { meta, body } = parseFrontmatter(text)

      if (!meta.name || !meta.description) {
        console.warn(`[skills] ${entry.name}/SKILL.md missing name or description — skipped`)
        continue
      }

      skills.push({
        name: String(meta.name),
        description: String(meta.description),
        content: body,
        argumentHint: meta['argument-hint'] ? String(meta['argument-hint']) : null,
        userInvocable: meta['user-invocable'] !== false,
        disableModelInvocation: meta['disable-model-invocation'] === true,
      })
    } catch {
      // SKILL.md missing or unreadable — skip
    }
  }

  if (skills.length) console.log(`[skills] Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`)
  return skills
}
