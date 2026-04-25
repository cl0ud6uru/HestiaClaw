/**
 * Base provider interface. All LLM adapters yield events from stream():
 *   { type: 'token',     content: string }
 *   { type: 'tool_call', id: string, name: string, input: object }
 */
export class Provider {
  get name() {
    throw new Error('Provider.name not implemented')
  }

  // eslint-disable-next-line no-unused-vars
  async *stream(_messages, _tools, _options) {
    yield* []
    throw new Error('Provider.stream not implemented')
  }
}
