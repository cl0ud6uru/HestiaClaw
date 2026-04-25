import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'

export function createProvider(config) {
  const type = config?.type || process.env.AGENT_PROVIDER || 'anthropic'

  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'openai':
      return new OpenAIProvider(config)
    default:
      throw new Error(`Unknown provider type: "${type}". Supported: anthropic, openai`)
  }
}
