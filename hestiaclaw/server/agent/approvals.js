import { randomUUID } from 'node:crypto'

export class ApprovalManager {
  constructor({ timeoutMs = 60000 } = {}) {
    this._timeoutMs = timeoutMs
    this._pending = new Map()
  }

  request(payload) {
    const id = randomUUID()

    const promise = new Promise(resolve => {
      const timeout = setTimeout(() => {
        this._pending.delete(id)
        resolve({ approved: false, reason: 'Approval timed out.' })
      }, this._timeoutMs)

      this._pending.set(id, { ...payload, id, resolve, timeout, createdAt: Date.now() })
    })

    return { id, promise }
  }

  resolve(id, approved, reason = '') {
    const item = this._pending.get(id)
    if (!item) return false

    clearTimeout(item.timeout)
    this._pending.delete(id)
    item.resolve({ approved, reason })
    return true
  }

  listPending() {
    return Array.from(this._pending.values()).map(item => ({
      id: item.id,
      runId: item.runId,
      toolCallId: item.toolCallId,
      name: item.name,
      input: item.input,
      risk: item.risk,
      kind: item.kind,
      createdAt: item.createdAt,
    }))
  }

  get timeoutMs() {
    return this._timeoutMs
  }
}
