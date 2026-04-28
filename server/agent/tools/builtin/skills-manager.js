import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseSkillManifest } from '../../skills.js'

const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/

function validateName(name) {
  if (!name || typeof name !== 'string') throw new Error('Skill name is required.')
  if (!VALID_NAME.test(name)) throw new Error(`Invalid skill name "${name}". Use lowercase letters, digits, and hyphens only (e.g. "morning-brief").`)
  if (name.length > 64) throw new Error('Skill name must be 64 characters or fewer.')
}

function buildSkillMd({ name, description, content, userInvocable, webhookSafe, disableModelInvocation, tags, defaultPolicy, argumentHint }) {
  const lines = ['---', `name: ${name}`, `description: ${description}`]

  if (typeof userInvocable === 'boolean') lines.push(`user-invocable: ${userInvocable}`)
  if (typeof disableModelInvocation === 'boolean') lines.push(`disable-model-invocation: ${disableModelInvocation}`)
  if (typeof webhookSafe === 'boolean') lines.push(`webhook-safe: ${webhookSafe}`)
  if (Array.isArray(tags) && tags.length > 0) lines.push(`tags: [${tags.join(', ')}]`)
  if (defaultPolicy && ['allow', 'ask', 'deny'].includes(defaultPolicy)) lines.push(`default-policy: ${defaultPolicy}`)
  if (argumentHint) lines.push(`argument-hint: ${argumentHint}`)

  lines.push('---', '', content.trim())
  return lines.join('\n') + '\n'
}

export function registerSkillsManagerTools(registry, skillsDir) {
  if (!skillsDir) return

  registry.register(
    'list_skills',
    'List all installed skills with their full SKILL.md content. Use this before creating or editing a skill to see what already exists.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      let entries
      try {
        entries = await readdir(skillsDir, { withFileTypes: true })
      } catch {
        return 'No skills directory found.'
      }

      const results = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = join(skillsDir, entry.name, 'SKILL.md')
        try {
          const text = await readFile(skillFile, 'utf8')
          results.push(`## ${entry.name}\n\`\`\`\n${text.trim()}\n\`\`\``)
        } catch {
          // SKILL.md missing — skip
        }
      }

      if (results.length === 0) return 'No skills are currently installed.'
      return results.join('\n\n')
    },
    { source: 'builtin', kind: 'read', risk: 'low' },
  )

  registry.register(
    'write_skill',
    'Create a new skill or update an existing one. Skills are markdown instruction sets injected into your system prompt when invoked via /skill-name. Changes take effect on the next turn.',
    {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill slug — lowercase letters, digits, hyphens (e.g. "morning-brief"). This becomes the /command name.',
        },
        description: {
          type: 'string',
          description: 'One-line description shown to the user and used by the model to decide when to invoke the skill.',
        },
        content: {
          type: 'string',
          description: 'The skill body — markdown instructions the agent follows when this skill is activated. Be specific and action-oriented.',
        },
        user_invocable: {
          type: 'boolean',
          description: 'Whether the user can invoke this skill with /name. Defaults to true.',
        },
        webhook_safe: {
          type: 'boolean',
          description: 'Whether this skill can run in webhook/automation context. Defaults to false.',
        },
        disable_model_invocation: {
          type: 'boolean',
          description: 'If true, the skill body is NOT injected into the model system prompt — usable only via /name slash command. Defaults to false.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of tags for categorization.',
        },
        argument_hint: {
          type: 'string',
          description: 'Optional hint shown to the user about what arguments this skill accepts.',
        },
      },
      required: ['name', 'description', 'content'],
    },
    async ({ name, description, content, user_invocable, webhook_safe, disable_model_invocation, tags, argument_hint }) => {
      validateName(name)
      if (!description?.trim()) throw new Error('description is required.')
      if (!content?.trim()) throw new Error('content is required.')

      const resolvedDir = resolve(skillsDir)
      const skillDir = resolve(skillsDir, name)
      // Guard against path traversal after resolve
      if (!skillDir.startsWith(resolvedDir + '/')) {
        throw new Error('Invalid skill name — path traversal detected.')
      }

      const md = buildSkillMd({
        name,
        description: description.trim(),
        content,
        userInvocable: typeof user_invocable === 'boolean' ? user_invocable : undefined,
        webhookSafe: typeof webhook_safe === 'boolean' ? webhook_safe : undefined,
        disableModelInvocation: typeof disable_model_invocation === 'boolean' ? disable_model_invocation : undefined,
        tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : undefined,
        argumentHint: argument_hint || undefined,
      })

      // Validate the constructed manifest parses correctly before writing
      const parsed = parseSkillManifest(md, name)
      if (!parsed) throw new Error('Failed to construct a valid skill manifest. Check name and description fields.')

      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), md, 'utf8')

      return `Skill "${name}" saved to ${join(skillDir, 'SKILL.md')}. It will be active starting the next turn.`
    },
    { source: 'builtin', kind: 'write', risk: 'medium', requiresApproval: true },
  )

  registry.register(
    'delete_skill',
    'Permanently delete an installed skill by name. The skill will be gone after this call.',
    {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill slug to delete (e.g. "morning-brief").',
        },
      },
      required: ['name'],
    },
    async ({ name }) => {
      validateName(name)

      const resolvedDir = resolve(skillsDir)
      const skillDir = resolve(skillsDir, name)
      if (!skillDir.startsWith(resolvedDir + '/')) {
        throw new Error('Invalid skill name — path traversal detected.')
      }

      try {
        await readFile(join(skillDir, 'SKILL.md'), 'utf8')
      } catch {
        throw new Error(`Skill "${name}" does not exist.`)
      }

      await rm(skillDir, { recursive: true, force: true })
      return `Skill "${name}" has been deleted.`
    },
    { source: 'builtin', kind: 'delete', risk: 'high', requiresApproval: true },
  )
}
