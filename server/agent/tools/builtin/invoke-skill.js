import { loadSkills } from '../../skills.js'

export function registerInvokeSkill(registry, skillsDir) {
  if (!skillsDir) return
  registry.register(
    'invoke_skill',
    'Load full instructions for an extended skill. Call this before executing a skill listed under Extended Skills.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name without leading slash.' },
        arguments: { type: 'string', description: 'User request or extra context for the skill.' },
      },
      required: ['name'],
    },
    async ({ name, arguments: args }) => {
      const skills = await loadSkills(skillsDir)
      const skill = skills.find(s => s.name === name)
      if (!skill) return `Skill "${name}" not found. Available skills: ${skills.map(s => s.name).join(', ')}`
      return `Skill: ${skill.name}\n\n${skill.content}${args ? `\n\nArguments: ${args}` : ''}`
    },
    { kind: 'read', risk: 'low' },
  )
}
