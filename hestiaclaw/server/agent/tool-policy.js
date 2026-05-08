// Tool Policy engine.
//
// Decouples three concerns that used to be tangled together:
//   1. Visibility — which tools the model can see/call this turn.
//   2. Approval  — whether execution requires user approval.
//   3. Source    — whether the calling channel (chat / voice / webhook)
//                  is allowed to run this tool.
//
// Persistence shape (stored under harness.toolPolicy in agent.config.json):
//   {
//     profile: 'home-control',
//     overrides: {
//       'home-assistant__ha_call_service': {
//         enabled: true, approval: 'writes', allowedSources: ['chat']
//       },
//       ...
//     }
//   }
//
// Approval modes:
//   never    — never require approval
//   writes   — approval if registry kind === 'write' OR risk !== 'low'
//   always   — always require approval
//   block    — tool is registered but cannot execute (any source)
//   default  — fall back to registry-inferred requiresApproval

export const SOURCES = ['chat', 'voice', 'webhook']
export const APPROVAL_MODES = ['default', 'never', 'writes', 'always', 'block']

// Built-in profiles. `include` is matched against tool names with the same
// glob convention used elsewhere in the harness: '*' matches all, 'prefix__*'
// matches tools whose name starts with 'prefix__', and exact names are
// matched literally.
export const TOOL_PROFILES = {
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    description: 'Chat only. Memory reads, web search, and Home Assistant read-only tools. No service calls or graph writes.',
    include: [
      'read_memory',
      'web_search',
      'invoke_skill',
      'home-assistant__ha_get_state',
      'home-assistant__ha_search_entities',
      'home-assistant__ha_get_entity',
      'home-assistant__ha_list_*',
      'graphiti__search_*',
      'graphiti__get_*',
    ],
    approvalDefault: 'writes',
    sourceRules: {
      voice:   { kindBlock: ['write'] },
      webhook: { kindBlock: ['write'] },
    },
  },
  'home-control': {
    id: 'home-control',
    name: 'Home Control',
    description: 'Home Assistant + memory. Service calls allowed (with approval on writes); destructive graph ops blocked.',
    include: [
      'read_memory',
      'write_memory',
      'write_daily_note',
      'web_search',
      'invoke_skill',
      'schedule_followup',
      'home-assistant__*',
      'graphiti__search_*',
      'graphiti__get_*',
      'graphiti__add_memory',
    ],
    approvalDefault: 'writes',
    sourceRules: {
      voice:   { riskBlock: ['high'] },
      webhook: { riskBlock: ['high'] },
    },
  },
  'full-agent': {
    id: 'full-agent',
    name: 'Full Agent',
    description: 'Everything except destructive graph wipes. Default for power users.',
    include: ['*'],
    exclude: ['graphiti__clear_graph'],
    approvalDefault: 'writes',
    sourceRules: {
      voice:   { riskBlock: ['high'] },
      webhook: { riskBlock: ['high'] },
    },
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    description: 'All tools, no source restrictions. Approval still applies to high-risk by default.',
    include: ['*'],
    approvalDefault: 'default',
    sourceRules: {},
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    description: 'No defaults — only your explicit per-tool overrides decide visibility.',
    include: [],
    approvalDefault: 'default',
    sourceRules: {},
  },
}

const DEFAULT_PROFILE_ID = 'home-control'

function matchesPattern(name, pattern) {
  if (pattern === '*') return true
  if (pattern.endsWith('__*')) return name.startsWith(pattern.slice(0, -1))
  if (pattern.endsWith('_*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

function matchesAny(name, patterns) {
  return patterns.some(p => matchesPattern(name, p))
}

export class ToolPolicy {
  constructor({ profile = DEFAULT_PROFILE_ID, overrides = {} } = {}) {
    this.profileId = TOOL_PROFILES[profile] ? profile : DEFAULT_PROFILE_ID
    this.overrides = { ...overrides }
  }

  get profile() {
    return TOOL_PROFILES[this.profileId]
  }

  toJSON() {
    return { profile: this.profileId, overrides: { ...this.overrides } }
  }

  setProfile(profileId) {
    if (!TOOL_PROFILES[profileId]) throw new Error(`Unknown tool profile "${profileId}"`)
    this.profileId = profileId
  }

  setOverride(toolName, override) {
    if (!override || (override.enabled === undefined && !override.approval && !override.allowedSources)) {
      delete this.overrides[toolName]
      return
    }
    const cleaned = {}
    if (typeof override.enabled === 'boolean') cleaned.enabled = override.enabled
    if (override.approval && APPROVAL_MODES.includes(override.approval)) cleaned.approval = override.approval
    if (Array.isArray(override.allowedSources)) {
      cleaned.allowedSources = override.allowedSources.filter(s => SOURCES.includes(s))
    }
    this.overrides[toolName] = cleaned
  }

  // Profile-only visibility (does not consult source rules).
  _profileAllows(toolName) {
    const p = this.profile
    if (p.exclude && matchesAny(toolName, p.exclude)) return false
    if (!p.include?.length) return false
    return matchesAny(toolName, p.include)
  }

  // Resolve the effective decision for one tool against one source.
  // Returns:
  //   { visible: bool, blocked: bool, approvalRequired: bool, reason?: string }
  resolve(tool, source) {
    const name = tool.name
    const override = this.overrides[name] || {}
    const profile = this.profile

    // Visibility
    let enabled
    if (typeof override.enabled === 'boolean') {
      enabled = override.enabled
    } else {
      enabled = this._profileAllows(name)
    }

    // Source allowance
    const allowedSources = override.allowedSources || null
    const sourceAllowed = !allowedSources || allowedSources.includes(source)

    // Profile source rules (kindBlock / riskBlock)
    const sourceRule = profile.sourceRules?.[source] || {}
    const kindBlocked = sourceRule.kindBlock?.includes(tool.kind) || false
    const riskBlocked = sourceRule.riskBlock?.includes(tool.risk) || false

    // Approval mode resolution
    const mode = override.approval || profile.approvalDefault || 'default'
    let approvalRequired = false
    if (mode === 'always') approvalRequired = true
    else if (mode === 'never') approvalRequired = false
    else if (mode === 'block') approvalRequired = false  // visible=false anyway
    else if (mode === 'writes') approvalRequired = tool.kind === 'write' || tool.risk !== 'low'
    else /* default */ approvalRequired = tool.requiresApproval === true

    const blocked = mode === 'block' || !sourceAllowed || kindBlocked || riskBlocked

    return {
      visible: enabled && !blocked,
      enabled,
      blocked,
      approvalRequired,
      mode,
      reason: !enabled
        ? 'tool not enabled in active profile'
        : mode === 'block'
          ? 'tool blocked by policy'
          : !sourceAllowed
            ? `source "${source}" not in allowedSources`
            : kindBlocked
              ? `${tool.kind} tools blocked from ${source}`
              : riskBlocked
                ? `${tool.risk}-risk tools blocked from ${source}`
                : null,
    }
  }

  // Convenience: visible tool definitions for a source. `tools` is the array
  // returned by registry.listTools() (carries metadata).
  visibleDefinitions(tools, source) {
    return tools
      .filter(t => !t.internalOnly)
      .filter(t => this.resolve(t, source).visible)
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  // For OpenAI tool_choice.allowed_tools mode: return all non-internal tool
  // definitions (cache-stable across turns) plus the subset of names that the
  // model is actually allowed to call this turn.
  cacheStableDefinitions(tools, source) {
    const definitions = tools
      .filter(t => !t.internalOnly)
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
    const allowedNames = tools
      .filter(t => !t.internalOnly && this.resolve(t, source).visible)
      .map(t => t.name)
    return { definitions, allowedNames }
  }

  canExecute(tool, source) {
    const r = this.resolve(tool, source)
    if (!r.visible) return { ok: false, reason: r.reason || 'blocked by tool policy' }
    return { ok: true }
  }

  approvalRequired(tool, source) {
    return this.resolve(tool, source).approvalRequired
  }
}

export function listProfiles() {
  return Object.values(TOOL_PROFILES).map(({ id, name, description }) => ({ id, name, description }))
}
