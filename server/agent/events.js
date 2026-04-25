export class AgentEventBus {
  constructor() {
    this._handlers = new Map()
  }

  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set())
    this._handlers.get(type).add(handler)
    return () => this._handlers.get(type)?.delete(handler)
  }

  async emit(type, payload) {
    const handlers = [
      ...Array.from(this._handlers.get('*') || []),
      ...Array.from(this._handlers.get(type) || []),
    ]

    for (const handler of handlers) {
      await handler({ type, payload })
    }
  }

  getHandlerCounts() {
    return Array.from(this._handlers.entries()).map(([type, handlers]) => ({
      type,
      count: handlers.size,
    }))
  }
}
