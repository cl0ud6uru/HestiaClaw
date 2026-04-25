import { useEffect, useMemo, useState } from 'react'
import './AgentPanel.css'

function formatTime(ts) {
  if (!ts) return 'n/a'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const EMPTY_DRAFT = {
  provider: '',
  model: '',
  systemPrompt: '',
  reasoningEffort: '',
  thinkingBudget: '',
  contextMaxMessages: 40,
  compactionEnabled: true,
}

export default function AgentPanel({ activeConversationTitle, onClose, onForkConversation, configVersion = 0 }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('diagnostics')
  const [togglingApprovals, setTogglingApprovals] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [models, setModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const toolsBySource = useMemo(() => {
    const grouped = new Map()
    for (const tool of data?.tools || []) {
      const source = tool.source || 'unknown'
      if (!grouped.has(source)) grouped.set(source, [])
      grouped.get(source).push(tool)
    }
    return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [data])

  const fetchModels = async (providerName) => {
    if (!providerName) return
    setModelsLoading(true)
    try {
      const res = await fetch(`/api/agent/models?provider=${encodeURIComponent(providerName)}`)
      if (res.ok) {
        const json = await res.json()
        setModels(json.models || [])
      } else {
        setModels([])
      }
    } catch {
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }

  const loadConfig = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/agent/config')
      if (!response.ok) {
        throw new Error(response.status === 404
          ? 'Native agent harness is not mounted.'
          : `Unable to load agent harness config (${response.status}).`)
      }
      const json = await response.json()
      setData(json)
      setDraft({
        provider: json.settings?.providerName || '',
        model: json.settings?.model || '',
        systemPrompt: json.settings?.systemPrompt || '',
        reasoningEffort: json.settings?.reasoningEffort || '',
        thinkingBudget: json.settings?.thinkingBudget ? String(json.settings.thinkingBudget) : '',
        contextMaxMessages: json.settings?.contextMaxMessages || 40,
        compactionEnabled: json.settings?.compactionEnabled !== false,
      })
      void fetchModels(json.settings?.providerName)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : 'Unable to load agent harness config.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void Promise.resolve().then(loadConfig)
  }, [configVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleApprovals = async () => {
    if (!data?.features?.approvalsConfigured || togglingApprovals) return
    setTogglingApprovals(true)
    try {
      await fetch('/api/agent/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvals: !data.features.approvals }),
      })
      await loadConfig()
    } finally {
      setTogglingApprovals(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/agent/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: draft.provider || undefined,
          model: draft.model || null,
          systemPrompt: draft.systemPrompt,
          reasoningEffort: draft.reasoningEffort || null,
          thinkingBudget: draft.thinkingBudget ? Number(draft.thinkingBudget) : null,
          contextMaxMessages: Number(draft.contextMaxMessages) || 40,
          compactionEnabled: draft.compactionEnabled,
        }),
      })
      if (!res.ok) throw new Error('Save failed.')
      setSaveMsg('Settings applied.')
      await loadConfig()
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const isOpenAI = draft.provider === 'openai'
  const isAnthropic = draft.provider === 'anthropic'

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <div>
          <div className="agent-panel__label">AGENT HARNESS</div>
          <div className="agent-panel__title">
            {data ? `${data.settings?.providerName || data.provider} / ${data.model || 'default'}` : 'Diagnostics'}
          </div>
        </div>
        <div className="agent-panel__actions">
          <button className={`agent-panel__tab-btn ${tab === 'diagnostics' ? 'agent-panel__tab-btn--active' : ''}`} type="button" onClick={() => setTab('diagnostics')}>DIAGNOSTICS</button>
          <button className={`agent-panel__tab-btn ${tab === 'settings' ? 'agent-panel__tab-btn--active' : ''}`} type="button" onClick={() => setTab('settings')}>SETTINGS</button>
          <button className="agent-panel__ghost" type="button" onClick={() => void loadConfig()} disabled={loading}>REFRESH</button>
          <button className="agent-panel__ghost" type="button" onClick={onForkConversation} title={activeConversationTitle ? `Fork ${activeConversationTitle}` : 'Fork active conversation'}>FORK</button>
          <button className="agent-panel__close" onClick={onClose} type="button">×</button>
        </div>
      </div>

      {loading && <div className="agent-panel__empty">Loading harness state...</div>}
      {error && <div className="agent-panel__message agent-panel__message--error">{error}</div>}

      {data && tab === 'diagnostics' && (
        <>
          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Runtime</div>
            <div className="agent-panel__stats">
              <div>
                <span>Tools</span>
                <strong>{data.toolCount}</strong>
              </div>
              <div>
                <span>Tracing</span>
                <strong>{data.features?.tracing ? 'ON' : 'OFF'}</strong>
              </div>
              <div
                className={data.features?.approvalsConfigured ? 'agent-panel__stat-toggle' : ''}
                onClick={data.features?.approvalsConfigured ? toggleApprovals : undefined}
                title={data.features?.approvalsConfigured ? 'Click to toggle' : 'Disabled in config'}
              >
                <span>Approvals</span>
                <strong className={data.features?.approvals ? 'agent-panel__stat-on' : 'agent-panel__stat-off'}>
                  {togglingApprovals ? '...' : data.features?.approvals ? 'ON' : 'OFF'}
                </strong>
              </div>
              <div>
                <span>Compaction</span>
                <strong>{data.features?.compaction ? 'ON' : 'OFF'}</strong>
              </div>
              <div>
                <span>Skills</span>
                <strong>{(data.skills || []).length}</strong>
              </div>
              <div>
                <span>Context</span>
                <strong>{data.settings?.contextMaxMessages || 'n/a'} msgs</strong>
              </div>
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">MCP Servers</div>
            <div className="agent-panel__list">
              {(data.mcpServers || []).map(server => (
                <div className="agent-panel__row" key={server.name}>
                  <div>
                    <strong>{server.name}</strong>
                    <span>{server.transport} · {server.toolCount} tools</span>
                    {server.error && <em>{server.error}</em>}
                  </div>
                  <b className={`agent-panel__status agent-panel__status--${server.status}`}>{server.status}</b>
                </div>
              ))}
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Skills</div>
            <div className="agent-panel__list">
              {(data.skills || []).map(skill => (
                <div className="agent-panel__row" key={skill.name}>
                  <div>
                    <strong>/{skill.name}</strong>
                    <span>{skill.description}</span>
                  </div>
                  <b className="agent-panel__status">{skill.argumentHint || 'invoke'}</b>
                </div>
              ))}
              {!data.skills?.length && <div className="agent-panel__empty">No skills found. Add SKILL.md files to the skills/ directory.</div>}
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Runtime Hooks</div>
            <div className="agent-panel__list">
              {(data.hooks || []).map(hook => (
                <div className="agent-panel__row" key={hook.type}>
                  <div>
                    <strong>{hook.type}</strong>
                    <span>{hook.count} handler{hook.count === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ))}
              {!data.hooks?.length && <div className="agent-panel__empty">No custom hook handlers registered yet.</div>}
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Tools</div>
            <div className="agent-panel__tool-groups">
              {toolsBySource.map(([source, tools]) => (
                <details key={source} className="agent-panel__tool-group" open={source === 'graphiti'}>
                  <summary>{source} <span>{tools.length}</span></summary>
                  {tools.map(tool => (
                    <div className="agent-panel__tool" key={tool.name}>
                      <div>
                        <strong>{tool.name}</strong>
                        <span>{tool.description}</span>
                      </div>
                      <b className={`agent-panel__risk agent-panel__risk--${tool.risk}`}>{tool.kind} · {tool.risk}</b>
                    </div>
                  ))}
                </details>
              ))}
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Recent Runs</div>
            <div className="agent-panel__list">
              {(data.recentRuns || []).map(run => (
                <div className="agent-panel__row" key={run.id}>
                  <div>
                    <strong>{formatTime(run.startedAt)}</strong>
                    <span>{run.provider} / {run.model || 'default'} · {run.toolCallCount} tools</span>
                    {run.error && <em>{run.error}</em>}
                  </div>
                  <b className={`agent-panel__status agent-panel__status--${run.status}`}>{run.status}</b>
                </div>
              ))}
              {!data.recentRuns?.length && <div className="agent-panel__empty">No agent runs recorded yet.</div>}
            </div>
          </section>
        </>
      )}

      {data && tab === 'settings' && (
        <div className="agent-panel__settings">
          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Provider</div>
            <div className="agent-panel__field-row">
              <label className="agent-panel__field">
                <span>Provider</span>
                <select
                  className="agent-panel__select"
                  value={draft.provider}
                  onChange={e => {
                    const p = e.target.value
                    setDraft(d => ({ ...d, provider: p, model: '' }))
                    void fetchModels(p)
                  }}
                >
                  <option value="">select provider</option>
                  {(data?.availableProviders || ['anthropic', 'openai']).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="agent-panel__field">
                <span>Model</span>
                <select
                  className="agent-panel__select"
                  value={draft.model}
                  onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
                  disabled={modelsLoading}
                >
                  <option value="">
                    {modelsLoading ? '(loading...)' : `provider default (${data?.settings?.providerDefault || '...'})`}
                  </option>
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">System Prompt</div>
            <textarea
              className="agent-panel__textarea"
              value={draft.systemPrompt}
              onChange={e => setDraft(d => ({ ...d, systemPrompt: e.target.value }))}
              rows={6}
              placeholder="Enter system prompt..."
            />
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Reasoning</div>
            <div className="agent-panel__field-row">
              {isOpenAI && (
                <label className="agent-panel__field">
                  <span>Effort</span>
                  <select
                    className="agent-panel__select"
                    value={draft.reasoningEffort}
                    onChange={e => setDraft(d => ({ ...d, reasoningEffort: e.target.value }))}
                  >
                    <option value="">auto (low when tools active)</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
              )}
              {isAnthropic && (
                <label className="agent-panel__field">
                  <span>Thinking budget (tokens)</span>
                  <input
                    className="agent-panel__input"
                    type="number"
                    min="0"
                    step="1024"
                    value={draft.thinkingBudget}
                    onChange={e => setDraft(d => ({ ...d, thinkingBudget: e.target.value }))}
                    placeholder="0 = disabled"
                  />
                </label>
              )}
              {!isOpenAI && !isAnthropic && (
                <div className="agent-panel__empty">Reasoning options depend on provider.</div>
              )}
            </div>
          </section>

          <section className="agent-panel__section">
            <div className="agent-panel__section-title">Context</div>
            <div className="agent-panel__field-row">
              <label className="agent-panel__field">
                <span>Max messages</span>
                <input
                  className="agent-panel__input"
                  type="number"
                  min="4"
                  max="200"
                  value={draft.contextMaxMessages}
                  onChange={e => setDraft(d => ({ ...d, contextMaxMessages: Number(e.target.value) }))}
                />
              </label>
              <label className="agent-panel__field agent-panel__field--checkbox">
                <input
                  type="checkbox"
                  checked={draft.compactionEnabled}
                  onChange={e => setDraft(d => ({ ...d, compactionEnabled: e.target.checked }))}
                />
                <span>Compaction enabled</span>
              </label>
            </div>
          </section>

          <div className="agent-panel__settings-footer">
            {saveMsg && <span className={saving ? '' : 'agent-panel__save-msg'}>{saveMsg}</span>}
            <button className="agent-panel__ghost" type="button" onClick={saveSettings} disabled={saving}>
              {saving ? 'APPLYING…' : 'APPLY CHANGES'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
