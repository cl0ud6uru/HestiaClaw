import OpenAI from 'openai'
import { Provider } from './base.js'

export class OpenAIProvider extends Provider {
  constructor(config) {
    super()
    this._model = config.model || 'gpt-5.4-mini'
    this._reasoningEffort = config.reasoningEffort || null
    this._client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      ...(config.baseURL || process.env.OPENAI_BASE_URL
        ? { baseURL: config.baseURL || process.env.OPENAI_BASE_URL }
        : {}),
    })
  }

  get name() {
    return 'openai'
  }

  get model() {
    return this._model
  }

  async listModels() {
    const ids = []
    for await (const model of this._client.models.list()) {
      ids.push(model.id)
    }
    return ids
      .filter(id => !/^(text-embedding-|tts-|whisper-|dall-e-|text-moderation|omni-moderation|babbage-002|davinci-002)/.test(id))
      .sort()
  }

  // Convert a Chat Completions messages array to Responses API input items.
  // Handles both old CC format (role:'tool', tool_calls:[]) and new Responses format.
  static _toResponsesInput(messages) {
    const input = []
    for (const msg of messages) {
      if (msg.role === 'system') continue // handled via instructions param

      // Old Chat Completions: assistant turn with tool_calls array
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        if (msg.content) input.push({ role: 'assistant', content: msg.content })
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        }
        continue
      }

      // Old Chat Completions: tool result turn
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: String(msg.content),
        })
        continue
      }

      // Already Responses format items (function_call, function_call_output)
      if (msg.type === 'function_call' || msg.type === 'function_call_output') {
        // Drop the id if it has an old call_ prefix — Responses API requires fc_ prefix
        if (msg.type === 'function_call' && msg.id?.startsWith('call_')) {
          const { id: _dropped, ...rest } = msg
          input.push(rest)
        } else {
          input.push(msg)
        }
        continue
      }

      // Regular user/assistant message
      input.push(msg)
    }
    return input
  }

  async *stream(messages, tools, options = {}) {
    const model = options.model || this._model
    const reasoningEffort = options.reasoningEffort !== undefined ? options.reasoningEffort : this._reasoningEffort

    const input = OpenAIProvider._toResponsesInput(messages)

    const responsesTools = tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }))

    const params = {
      model,
      input,
      stream: true,
      ...(options.system ? { instructions: options.system } : {}),
      ...(responsesTools.length ? { tools: responsesTools } : {}),
      // Responses API: reasoning is a nested object. Only applied on tool-free turns
      // because tool calls + reasoning together can cause API errors on some models.
      ...(reasoningEffort && !responsesTools.length
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    }

    const stream = await this._client.responses.create(params)

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'token', content: event.delta }
      } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        let input = {}
        try { input = JSON.parse(event.item.arguments || '{}') } catch { /* malformed */ }
        yield { type: 'tool_call', id: event.item.call_id, _itemId: event.item.id, name: event.item.name, input }
      }
    }
  }

  // Returns an array of Responses API input items representing this assistant turn.
  static buildAssistantTurn(text, toolCalls) {
    const items = []
    if (text) items.push({ role: 'assistant', content: text })
    for (const tc of toolCalls) {
      items.push({
        type: 'function_call',
        id: tc._itemId || tc.id,  // fc_xxx item ID for Responses API; call_xxx fallback for old history
        call_id: tc.id,           // call_xxx used to pair with function_call_output
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      })
    }
    return items
  }

  static buildToolResultTurn(toolResults) {
    return toolResults.map(r => ({
      type: 'function_call_output',
      call_id: r.id,
      output: String(r.result),
    }))
  }
}
