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
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      // Inline YAML array: [home, morning]
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    } else {
      meta[key] = raw
    }
  }

  return { meta, body: match[2].trim() }
}

export function parseSkillManifest(text, sourceName = '') {
  const { meta, body } = parseFrontmatter(text)

  if (!meta.name) {
    console.warn(`[skills] ${sourceName}: missing required field 'name' — skipped`)
    return null
  }
  if (!meta.description) {
    console.warn(`[skills] ${sourceName}: missing required field 'description' — skipped`)
    return null
  }

  return {
    // Agent Skills standard fields
    name: String(meta.name),
    description: String(meta.description),
    license: meta.license ? String(meta.license) : null,
    compatibility: meta.compatibility ? String(meta.compatibility) : null,
    // Skill content body
    content: body,
    // HestiaClaw extensions
    argumentHint: meta['argument-hint'] ? String(meta['argument-hint']) : null,
    userInvocable: meta['user-invocable'] !== false,
    disableModelInvocation: meta['disable-model-invocation'] === true,
    webhookSafe: meta['webhook-safe'] === true,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    defaultPolicy: ['allow', 'ask', 'deny'].includes(meta['default-policy']) ? meta['default-policy'] : 'allow',
  }
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
      const skill = parseSkillManifest(text, `${entry.name}/SKILL.md`)
      if (skill) skills.push(skill)
    } catch {
      // SKILL.md missing or unreadable — skip
    }
  }

  if (skills.length) console.log(`[skills] Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`)
  return skills
}
