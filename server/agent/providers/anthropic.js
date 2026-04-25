import Anthropic from '@anthropic-ai/sdk'
import { Provider } from './base.js'

const THINKING_MIN_TOKENS = 1024

export class AnthropicProvider extends Provider {
  constructor(config) {
    super()
    this._model = config.model || 'claude-opus-4-7'
    this._thinkingBudget = config.thinkingBudget || null
    this._client = new Anthropic({ apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY })
  }

  get name() {
    return 'anthropic'
  }

  get model() {
    return this._model
  }

  async listModels() {
    const page = await this._client.models.list({ limit: 100 })
    return (page.data || []).map(m => m.id).sort()
  }

  async *stream(messages, tools, options = {}) {
    const model = options.model || this._model
    const thinkingBudget = options.thinkingBudget !== undefined ? options.thinkingBudget : this._thinkingBudget

    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))

    // Extended thinking requires max_tokens > budget_tokens
    const budgetTokens = thinkingBudget ? Math.max(thinkingBudget, THINKING_MIN_TOKENS) : null
    const maxTokens = budgetTokens ? Math.max((options.maxTokens || 8096), budgetTokens + 1024) : (options.maxTokens || 8096)

    const params = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(options.system ? { system: options.system } : {}),
      ...(anthropicTools.length ? { tools: anthropicTools } : {}),
      ...(budgetTokens ? { thinking: { type: 'enabled', budget_tokens: budgetTokens } } : {}),
    }

    const stream = await this._client.messages.stream(params)

    const pendingToolCalls = {}
    const pendingThinkingBlocks = {}

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          pendingToolCalls[event.index] = {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          }
        } else if (event.content_block.type === 'thinking') {
          pendingThinkingBlocks[event.index] = { text: '' }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'token', content: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          if (pendingToolCalls[event.index]) {
            pendingToolCalls[event.index].inputJson += event.delta.partial_json
          }
        } else if (event.delta.type === 'thinking_delta') {
          if (pendingThinkingBlocks[event.index]) {
            pendingThinkingBlocks[event.index].text += event.delta.thinking
            yield { type: 'thinking_token', content: event.delta.thinking }
          }
        }
      } else if (event.type === 'content_block_stop') {
        if (pendingToolCalls[event.index]) {
          const tc = pendingToolCalls[event.index]
          let input = {}
          try { input = JSON.parse(tc.inputJson) } catch { /* malformed */ }
          yield { type: 'tool_call', id: tc.id, name: tc.name, input }
          delete pendingToolCalls[event.index]
        } else if (pendingThinkingBlocks[event.index]) {
          yield { type: 'thinking_block', content: pendingThinkingBlocks[event.index].text }
          delete pendingThinkingBlocks[event.index]
        }
      }
    }
  }

  // Content parts may include thinking blocks — must be passed in order (thinking → text → tool_use)
  static buildAssistantTurn(contentParts) {
    return { role: 'assistant', content: contentParts }
  }

  static buildToolResultTurn(toolResults) {
    return {
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: String(r.result),
      })),
    }
  }
}
