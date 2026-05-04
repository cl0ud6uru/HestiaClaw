import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TOOL_NAME_MAX_LENGTH = 64
const TOOL_NAME_HASH_LENGTH = 8

export class McpClientManager {
  constructor(registry) {
    this._registry = registry
    this._clients = []
    this._servers = []
  }

  async init(mcpServers = {}) {
    const entries = Object.entries(mcpServers)
    this._servers = []
    if (!entries.length) return

    for (const [serverName, config] of entries) {
      try {
        await this._connectServer(serverName, config)
      } catch (err) {
        console.error(`[mcp] Failed to connect "${serverName}":`, err.message)
        this._servers.push({
          name: serverName,
          status: 'error',
          transport: config.url ? (config.transport || 'auto') : 'stdio',
          url: config.url || null,
          command: config.command || null,
          toolCount: 0,
          error: err.message,
        })
      }
    }

    console.log(`[mcp] Connected ${this._clients.length}/${entries.length} MCP server(s)`)
  }

  async _connectServer(serverName, config) {
    const { client, transportType } = await this._connectTransport(serverName, config)

    const { tools } = await client.listTools()
    let registered = 0
    const serverToolNames = new Set()

    for (const tool of tools) {
      const qualifiedName = this._uniqueToolName(serverName, tool.name, serverToolNames)
      serverToolNames.add(qualifiedName)
      this._registry.register(
        qualifiedName,
        `[${serverName}] ${tool.description || tool.name}`,
        tool.inputSchema || { type: 'object', properties: {} },
        async (input) => {
          const result = await client.callTool({ name: tool.name, arguments: input })
          return result.content?.map(c => c.text || '').join('\n') || ''
        },
        {
          source: serverName,
          displayName: `${serverName}: ${tool.name}`,
          kind: this._inferToolKind(tool.name),
          risk: this._inferToolRisk(tool.name),
          requiresApproval: this._requiresApproval(tool.name),
          timeoutMs: 30000,
        },
      )
      registered++
    }

    this._clients.push({ name: serverName, client })
    this._servers.push({
      name: serverName,
      status: 'connected',
      transport: transportType,
      url: config.url || null,
      command: config.command || null,
      toolCount: registered,
      error: null,
    })
    console.log(`[mcp] "${serverName}" (${transportType}): registered ${registered} tool(s)`)
  }

  async _connectTransport(serverName, config) {
    if (config.url) {
      return this._connectHttpTransport(serverName, config)
    }

    if (!config.command) {
      throw new Error('MCP server config requires either "command" for stdio or "url" for HTTP transport')
    }

    const env = this._resolveEnv(config.env || {})
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...env },
    })
    const client = this._createClient()
    await client.connect(transport)
    return { client, transportType: 'stdio' }
  }

  async _connectHttpTransport(serverName, config) {
    const url = new URL(config.url)
    const headers = this._resolveEnv(config.headers || {})
    const requestInit = Object.keys(headers).length ? { headers } : undefined
    const transportPreference = config.transport || 'auto'

    if (transportPreference === 'streamable-http' || transportPreference === 'auto') {
      const client = this._createClient()
      const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)

      try {
        await client.connect(transport)
        return { client, transportType: 'streamable-http' }
      } catch (err) {
        await client.close().catch(() => {})
        if (transportPreference === 'streamable-http') throw err
        console.warn(`[mcp] "${serverName}": streamable HTTP failed, trying SSE: ${err.message}`)
      }
    }

    if (transportPreference === 'sse' || transportPreference === 'auto') {
      const client = this._createClient()
      const transport = new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
      await client.connect(transport)
      return { client, transportType: 'sse' }
    }

    throw new Error(`Unsupported MCP transport "${transportPreference}"`)
  }

  _createClient() {
    return new Client(
      { name: 'hestia', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
  }

  _uniqueToolName(serverName, toolName, reservedNames) {
    let candidate = this._safeToolName(serverName, toolName)
    let counter = 2

    while (reservedNames.has(candidate) || this._registry.has(candidate)) {
      if (counter > 100) {
        throw new Error(`Unable to create unique tool name for "${serverName}/${toolName}"`)
      }
      const hash = this._toolNameHash(serverName, `${toolName}:${counter}`)
      candidate = this._hashedToolName(
        this._sanitizeToolNamePart(serverName, 'server'),
        this._sanitizeToolNamePart(toolName, 'tool'),
        hash,
      )
      counter++
    }

    return candidate
  }

  _safeToolName(serverName, toolName) {
    const sep = '__'
    const safeServerName = this._sanitizeToolNamePart(serverName, 'server')
    const safeToolName = this._sanitizeToolNamePart(toolName, 'tool')
    const full = `${safeServerName}${sep}${safeToolName}`
    if (full.length <= TOOL_NAME_MAX_LENGTH) return full
    return this._hashedToolName(safeServerName, safeToolName, this._toolNameHash(serverName, toolName))
  }

  _hashedToolName(serverName, toolName, hash) {
    const sep = '__'
    const suffix = `_${hash}`
    const maxBaseLength = TOOL_NAME_MAX_LENGTH - suffix.length

    if (toolName.length >= maxBaseLength) {
      return `${toolName.slice(0, maxBaseLength)}${suffix}`
    }

    const maxServerLength = maxBaseLength - sep.length - toolName.length
    if (maxServerLength > 0) {
      return `${serverName.slice(0, maxServerLength)}${sep}${toolName}${suffix}`
    }

    return `${toolName.slice(0, maxBaseLength)}${suffix}`
  }

  _sanitizeToolNamePart(value, fallback) {
    const sanitized = String(value || '')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    return sanitized || fallback
  }

  _toolNameHash(serverName, toolName) {
    return createHash('sha256')
      .update(`${serverName}:${toolName}`)
      .digest('hex')
      .slice(0, TOOL_NAME_HASH_LENGTH)
  }

  _inferToolKind(toolName) {
    return /^(add|create|update|set|delete|clear|remove|write|turn_|lock|unlock)/i.test(toolName)
      ? 'write'
      : 'read'
  }

  _inferToolRisk(toolName) {
    if (/^(delete|clear|remove|lock|unlock)/i.test(toolName)) return 'high'
    if (/^(add|create|update|set|write|turn_)/i.test(toolName)) return 'medium'
    return 'low'
  }

  _requiresApproval(toolName) {
    return this._inferToolRisk(toolName) !== 'low'
  }

  _resolveEnv(envMap) {
    const resolved = {}
    for (const [key, value] of Object.entries(envMap)) {
      // Expand ${VAR_NAME} references
      resolved[key] = String(value).replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '')
    }
    return resolved
  }

  async shutdown() {
    for (const { client } of this._clients) {
      try { await client.close() } catch { /* ignore */ }
    }
    this._clients = []
  }

  getServers() {
    return this._servers.map(server => ({ ...server }))
  }
}
