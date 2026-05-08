import { DEFAULT_SYSTEM_PROMPT } from './prompts/default-system-prompt.js'

// Resolve the effective base system prompt for the agent.
//
// By default the built-in prompt is locked: it ships with the app and is the
// only source of the core memory + Home Assistant control policy. SOUL.md
// remains the supported per-install customization layer (prepended at turn
// time by the routers).
//
// Developers can opt out of the lock with either:
//   - agentConfig.harness.systemPromptLocked === false
//   - HESTIA_SYSTEM_PROMPT_LOCKED=false
// In that case, agentConfig.systemPrompt (when non-empty) replaces the default.
//
// Returns: { systemPrompt, systemPromptLocked, systemPromptSource }
export function resolveSystemPrompt(agentConfig = {}, env = process.env) {
  const envOverride = env?.HESTIA_SYSTEM_PROMPT_LOCKED
  const locked = envOverride === 'false'
    ? false
    : agentConfig?.harness?.systemPromptLocked !== false

  if (!locked && typeof agentConfig?.systemPrompt === 'string' && agentConfig.systemPrompt.trim()) {
    return {
      systemPrompt: agentConfig.systemPrompt.trim(),
      systemPromptLocked: false,
      systemPromptSource: 'config',
    }
  }

  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT.trim(),
    systemPromptLocked: locked,
    systemPromptSource: 'builtin',
  }
}
