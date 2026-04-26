export class ToolRegistry {
  constructor() {
    this._tools = new Map()
  }

  register(name, description, parameters, executeFn, metadata = {}) {
    this._tools.set(name, {
      name,
      description,
      parameters,
      execute: executeFn,
      source: metadata.source || 'builtin',
      displayName: metadata.displayName || name,
      kind: metadata.kind || 'read',
      risk: metadata.risk || 'low',
      requiresApproval: metadata.requiresApproval === true,
      timeoutMs: Number(metadata.timeoutMs) || null,
    })
  }

  has(name) {
    return this._tools.has(name)
  }

  get(name) {
    const tool = this._tools.get(name)
    if (!tool) return null
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      source: tool.source,
      displayName: tool.displayName,
      kind: tool.kind,
      risk: tool.risk,
      requiresApproval: tool.requiresApproval,
      timeoutMs: tool.timeoutMs,
    }
  }

  getDefinitions(allowedTools = null) {
    const tools = Array.from(this._tools.values())
    const filtered = allowedTools === null
      ? tools
      : tools.filter(t => allowedTools.some(p =>
          p === '*' ||
          (p.endsWith('__*') ? t.name.startsWith(p.slice(0, -1)) : t.name === p)
        ))
    return filtered.map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  listTools() {
    return Array.from(this._tools.values()).map(({
      name,
      description,
      parameters,
      source,
      displayName,
      kind,
      risk,
      requiresApproval,
      timeoutMs,
    }) => ({
      name,
      description,
      parameters,
      source,
      displayName,
      kind,
      risk,
      requiresApproval,
      timeoutMs,
    }))
  }

  async execute(name, input) {
    const tool = this._tools.get(name)
    if (!tool) throw new Error(`Tool "${name}" not found in registry`)
    if (!tool.timeoutMs) return tool.execute(input)

    let timeout
    try {
      return await Promise.race([
        tool.execute(input),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  get size() {
    return this._tools.size
  }
}
