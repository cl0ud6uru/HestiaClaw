import { useEffect, useRef, useState } from 'react'
import AccountPanel from './components/AccountPanel'
import AgentPanel from './components/AgentPanel'
import ChatBackground from './components/ChatBackground'
import ChatInput from './components/ChatInput'
import ChatMessage from './components/ChatMessage'
import AutomationsView from './components/AutomationsView'
import GraphView from './components/GraphView'
import HeaderOrb from './components/HeaderOrb'
import LoginScreen from './components/LoginScreen'
import Sidebar from './components/Sidebar'
import ThinkingAnimation from './components/ThinkingAnimation'
import { getVoiceStorageKey, RealtimeTranscriber } from './lib/voice'
import './App.css'

const STORAGE_KEY = 'hestia-conversations'
const AGENT_MODE_KEY = 'hestia-agent-mode'
const GREETING = 'Hestia online. How can I help?'

function createConversation() {
  return {
    id: crypto.randomUUID(),
    title: 'New Conversation',
    messages: [{ id: 0, role: 'assistant', content: GREETING, streaming: false }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function getStorageKey(userId) {
  return `${STORAGE_KEY}:user:${userId}`
}

function loadConversations(userId) {
  if (!userId) return []

  try {
    const raw = localStorage.getItem(getStorageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch { /* ignore parse errors */ }

  return [createConversation()]
}

async function readError(response, fallback) {
  try {
    const data = await response.json()
    return data?.error || fallback
  } catch {
    return fallback
  }
}

export default function App() {
  const [sessionLoading, setSessionLoading] = useState(true)
  const [authBusy, setAuthBusy] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [authError, setAuthError] = useState('')
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [storageReady, setStorageReady] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [agentMode, setAgentMode] = useState(() => localStorage.getItem(AGENT_MODE_KEY) || 'n8n')
  const [isThinking, setIsThinking] = useState(false)
  const [activeToolName, setActiveToolName] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [showAutomations, setShowAutomations] = useState(false)
  const [memoryPulseAt, setMemoryPulseAt] = useState(null)
  const [agentConfigVersion, setAgentConfigVersion] = useState(0)
  const [skills, setSkills] = useState([])
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsSuccess, setSettingsSuccess] = useState('')
  const [voiceCatalog, setVoiceCatalog] = useState([])
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const [voiceDraft, setVoiceDraft] = useState('')
  const [voiceState, setVoiceState] = useState('idle')
  const [selectedVoiceId, setSelectedVoiceId] = useState('')
  const [defaultVoiceId, setDefaultVoiceId] = useState('')
  const [sttModelId, setSttModelId] = useState('scribe_v2_realtime')
  const bottomRef = useRef(null)
  const transcriberRef = useRef(null)
  const speechPlaybackRef = useRef(null)
  const speechUrlRef = useRef('')
  const fetchedVoiceConvsRef = useRef(new Set())

  const activeConv = conversations.find(c => c.id === activeId) ?? conversations[0] ?? null
  const messages = activeConv?.messages ?? []

  function syncServerConversations() {
    fetch('/api/agent/conversations')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.conversations?.length) return
        setConversations(prev => {
          const serverById = new Map(data.conversations.map(c => [c.id, c]))
          // Update updatedAt for existing conversations that got new HA messages
          let changed = false
          const updated = prev.map(c => {
            const srv = serverById.get(c.id)
            if (srv && srv.updatedAt > (c.updatedAt || 0)) {
              changed = true
              return { ...c, updatedAt: srv.updatedAt }
            }
            return c
          })
          // Add brand-new server-side conversations not yet in localStorage
          const existingIds = new Set(prev.map(c => c.id))
          const incoming = data.conversations
            .filter(c => !existingIds.has(c.id))
            .map(c => ({
              id: c.id,
              title: c.firstMessage ? c.firstMessage.slice(0, 60) : 'Voice session',
              messages: [{ id: 0, role: 'assistant', content: GREETING, streaming: false }],
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
              source: 'voice',
            }))
          if (!changed && !incoming.length) return prev
          return [...updated, ...incoming].sort((a, b) => b.updatedAt - a.updatedAt)
        })
      })
      .catch(() => {})
  }

  useEffect(() => {
    const hydrateSession = async () => {
      try {
        const response = await fetch('/api/auth/session')
        const data = await response.json()
        setAuthUser(data.authenticated ? data.user : null)
      } catch {
        setAuthError('Unable to reach the local auth service.')
      } finally {
        setSessionLoading(false)
      }
    }

    void hydrateSession()
  }, [])

  useEffect(() => {
    if (!authUser) {
      transcriberRef.current?.cancel()
      transcriberRef.current = null
      if (speechPlaybackRef.current) {
        speechPlaybackRef.current.pause()
        speechPlaybackRef.current = null
      }
      if (speechUrlRef.current) {
        URL.revokeObjectURL(speechUrlRef.current)
        speechUrlRef.current = ''
      }
      setConversations([])
      setActiveId(null)
      setStorageReady(false)
      setSettingsOpen(false)
      setAgentPanelOpen(false)
      setIsThinking(false)
      setActiveToolName(null)
      setVoiceCatalog([])
      setVoiceLoading(false)
      setVoiceError('')
      setVoiceDraft('')
      setVoiceState('idle')
      setSelectedVoiceId('')
      setDefaultVoiceId('')
      return
    }

    const loaded = loadConversations(authUser.id)
    setConversations(loaded)
    setActiveId(loaded[0]?.id ?? null)
    setStorageReady(true)

    syncServerConversations()
  }, [authUser])

  // Poll server conversations every 30s to pick up new HA voice sessions and update sort order
  useEffect(() => {
    if (!authUser) return
    const interval = setInterval(syncServerConversations, 30000)
    return () => clearInterval(interval)
  }, [authUser]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!authUser) return

    let cancelled = false

    const loadVoiceCatalog = async () => {
      setVoiceLoading(true)

      try {
        const response = await fetch('/api/voice/voices')
        if (response.status === 401) {
          setAuthUser(null)
          return
        }

        if (!response.ok) {
          throw new Error(await readError(response, 'Unable to load voice options.'))
        }

        const data = await response.json()
        if (cancelled) return

        const nextDefault = String(data.defaultVoiceId || '')
        const storedVoiceId = localStorage.getItem(getVoiceStorageKey(authUser.id)) || ''
        const availableIds = new Set((data.voices || []).map(voice => voice.voiceId))
        const nextSelected = availableIds.has(storedVoiceId) ? storedVoiceId : nextDefault

        setVoiceCatalog(Array.isArray(data.voices) ? data.voices : [])
        setDefaultVoiceId(nextDefault)
        setSelectedVoiceId(nextSelected)
        setSttModelId(String(data.sttModelId || 'scribe_v2_realtime'))
        setVoiceError('')
      } catch (error) {
        if (!cancelled) {
          setVoiceCatalog([])
          setVoiceError(error instanceof Error ? error.message : 'Unable to load voice options.')
        }
      } finally {
        if (!cancelled) {
          setVoiceLoading(false)
        }
      }
    }

    void loadVoiceCatalog()

    return () => {
      cancelled = true
    }
  }, [authUser])

  useEffect(() => {
    if (!authUser || !storageReady) return
    localStorage.setItem(getStorageKey(authUser.id), JSON.stringify(conversations))
  }, [authUser, conversations, storageReady])

  useEffect(() => {
    if (!authUser) { setSkills([]); return }
    fetch('/api/agent/config')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.skills) setSkills(data.skills) })
      .catch(() => {})
  }, [authUser])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeConv?.updatedAt, isThinking])

  // Load server-side message history for voice/webhook conversations on first select
  useEffect(() => {
    if (!activeConv || activeConv.source !== 'voice') return
    if (fetchedVoiceConvsRef.current.has(activeConv.id)) return
    fetchedVoiceConvsRef.current.add(activeConv.id)
    fetch(`/api/agent/conversations/${activeConv.id}/messages`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.messages?.length) return
        setConversations(prev => prev.map(c =>
          c.id === activeConv.id ? { ...c, messages: data.messages } : c
        ))
      })
      .catch(() => {})
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    transcriberRef.current?.cancel()
    if (speechPlaybackRef.current) {
      speechPlaybackRef.current.pause()
    }
    if (speechUrlRef.current) {
      URL.revokeObjectURL(speechUrlRef.current)
      speechUrlRef.current = ''
    }
  }, [])

  useEffect(() => {
    if (!authUser || !selectedVoiceId) return
    localStorage.setItem(getVoiceStorageKey(authUser.id), selectedVoiceId)
  }, [authUser, selectedVoiceId])

  const cancelSpeechPlayback = () => {
    if (speechPlaybackRef.current) {
      speechPlaybackRef.current.pause()
      speechPlaybackRef.current.src = ''
      speechPlaybackRef.current = null
    }
    if (speechUrlRef.current) {
      URL.revokeObjectURL(speechUrlRef.current)
      speechUrlRef.current = ''
    }
  }

  const fetchVoiceToken = async (type) => {
    const response = await fetch('/api/voice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    })

    if (response.status === 401) {
      setAuthUser(null)
      throw new Error('Session expired. Please sign in again.')
    }

    if (!response.ok) {
      throw new Error(await readError(response, 'Unable to initialize voice service.'))
    }

    const data = await response.json()
    if (data.defaultVoiceId) setDefaultVoiceId(data.defaultVoiceId)
    if (data.sttModelId) setSttModelId(data.sttModelId)
    return data.token
  }

  const transcribeVoiceFallback = async (blob) => {
    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    const chunkSize = 0x8000

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }

    const response = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: btoa(binary),
        mimeType: blob.type || 'audio/webm',
        fileName: 'voice-input.webm',
      }),
    })

    if (response.status === 401) {
      setAuthUser(null)
      throw new Error('Session expired. Please sign in again.')
    }

    if (!response.ok) {
      throw new Error(await readError(response, 'Unable to transcribe recorded audio.'))
    }

    const data = await response.json()
    return String(data.text || '').trim()
  }

  const playVoiceReply = async (text, voiceId) => {
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    })

    if (response.status === 401) {
      setAuthUser(null)
      throw new Error('Session expired. Please sign in again.')
    }

    if (!response.ok) {
      throw new Error(await readError(response, 'Unable to generate assistant speech.'))
    }

    const audioBlob = await response.blob()
    if (!audioBlob.size) {
      throw new Error('Empty assistant speech response.')
    }

    cancelSpeechPlayback()
    const objectUrl = URL.createObjectURL(audioBlob)
    speechUrlRef.current = objectUrl

    const audio = new Audio(objectUrl)
    speechPlaybackRef.current = audio
    audio.addEventListener('ended', () => {
      if (speechPlaybackRef.current === audio) {
        speechPlaybackRef.current = null
      }
      if (speechUrlRef.current === objectUrl) {
        URL.revokeObjectURL(objectUrl)
        speechUrlRef.current = ''
      }
    }, { once: true })

    await audio.play()
  }

  const updateMessages = (id, updater) => {
    setConversations(prev =>
      prev.map(c => c.id === id
        ? { ...c, messages: updater(c.messages), updatedAt: Date.now() }
        : c
      )
    )
  }

  const autoTitle = (id, text) => {
    setConversations(prev =>
      prev.map(c => c.id === id && c.title === 'New Conversation'
        ? { ...c, title: text.length > 42 ? text.slice(0, 40) + '…' : text }
        : c
      )
    )
  }

  const startNewChat = () => {
    cancelSpeechPlayback()
    const conv = createConversation()
    setConversations(prev => [conv, ...prev])
    setActiveId(conv.id)
    setIsThinking(false)
  }

  const selectConversation = (id) => {
    if (id === activeId) return
    cancelSpeechPlayback()
    setActiveId(id)
    setIsThinking(false)
  }

  const deleteConversation = (id) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id)
      if (next.length === 0) {
        cancelSpeechPlayback()
        const fresh = createConversation()
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeId) {
        cancelSpeechPlayback()
        setActiveId(next[0].id)
        setIsThinking(false)
      }
      return next
    })
  }

  const handleLogin = async ({ username, password }) => {
    setAuthBusy(true)
    setAuthError('')

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (!response.ok) {
        throw new Error(await readError(response, 'Login failed.'))
      }

      const data = await response.json()
      setAuthUser(data.user)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = async () => {
    setAuthBusy(true)
    setAuthError('')
    cancelSpeechPlayback()

    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      setAuthUser(null)
    } catch {
      setAuthError('Unable to end the current session.')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleVoiceSelection = (voiceId) => {
    setSelectedVoiceId(voiceId)
    setVoiceError('')
  }

  const handleVoiceStart = async () => {
    if (isThinking || voiceState !== 'idle' || !authUser) return

    try {
      cancelSpeechPlayback()
      setVoiceError('')
      setVoiceDraft('')

      const transcriber = new RealtimeTranscriber({
        getToken: fetchVoiceToken,
        fallbackTranscribe: transcribeVoiceFallback,
        modelId: sttModelId,
        onPartial: setVoiceDraft,
        onStateChange: setVoiceState,
      })

      transcriberRef.current = transcriber
      await transcriber.start()
    } catch (error) {
      transcriberRef.current?.cancel()
      transcriberRef.current = null
      setVoiceDraft('')
      setVoiceState('idle')
      setVoiceError(error instanceof Error ? error.message : 'Unable to access the microphone.')
    }
  }

  const handleVoiceStop = async () => {
    const transcriber = transcriberRef.current
    if (!transcriber) return

    transcriberRef.current = null
    const result = await transcriber.stop()
    setVoiceDraft('')

    if (result.error) {
      setVoiceError(result.error)
      return
    }

    if (!result.text) {
      setVoiceError('No speech detected.')
      return
    }

    await sendMessage(result.text, { speakReply: true })
  }

  const handleCredentialUpdate = async ({ currentPassword, newUsername, newPassword }) => {
    setSettingsBusy(true)
    setSettingsError('')
    setSettingsSuccess('')

    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newUsername, newPassword }),
      })

      if (!response.ok) {
        throw new Error(await readError(response, 'Unable to update credentials.'))
      }

      const data = await response.json()
      setAuthUser(data.user)
      setSettingsSuccess('Credentials updated.')
      return true
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Unable to update credentials.')
      return false
    } finally {
      setSettingsBusy(false)
    }
  }

  const handleCommand = (name) => {
    if (name === 'new-chat') startNewChat()
  }

  const handleAgentModeChange = (mode) => {
    setAgentMode(mode)
    localStorage.setItem(AGENT_MODE_KEY, mode)
  }

  const resolveToolApproval = async (approvalId, approved, reason = '') => {
    const response = await fetch(`/api/agent/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, reason }),
    })

    if (!response.ok) {
      throw new Error(await readError(response, 'Unable to resolve tool approval.'))
    }
  }

  const forkActiveAgentConversation = async () => {
    if (!activeConv) return

    const fork = {
      ...activeConv,
      id: crypto.randomUUID(),
      title: `${activeConv.title} fork`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: activeConv.messages.map(message => ({ ...message })),
    }

    setConversations(prev => [fork, ...prev])
    setActiveId(fork.id)

    try {
      const response = await fetch('/api/agent/conversations/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_conversation_id: activeConv.id,
          target_conversation_id: fork.id,
        }),
      })

      if (!response.ok) {
        throw new Error(await readError(response, 'Unable to fork agent history.'))
      }
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : 'Unable to fork agent history.')
    }
  }

  const sendMessageAgent = async (text, options = {}) => {
    if (!text.trim() || isThinking || !activeConv) return

    cancelSpeechPlayback()
    setVoiceError('')
    const convId = activeConv.id
    const userMsg = { id: Date.now(), role: 'user', content: text, streaming: false }
    updateMessages(convId, prev => [...prev, userMsg])
    autoTitle(convId, text)
    setIsThinking(true)

    const assistantId = Date.now() + 1
    const toolCallsAccum = []
    const shouldSpeakReply = options.speakReply === true
    const playbackVoiceId = selectedVoiceId || defaultVoiceId
    let finalAssistantReply = ''
    let streamingActive = false

    const startStreaming = () => {
      if (streamingActive) return
      streamingActive = true
      setIsThinking(false)
      updateMessages(convId, prev => [...prev, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    }

    const appendChunk = (chunk) => {
      if (!chunk) return
      finalAssistantReply += chunk
      updateMessages(convId, prev =>
        prev.map(m => m.id === assistantId ? { ...m, content: m.content + chunk } : m),
      )
    }

    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: convId }),
      })

      if (response.status === 401) {
        setAuthUser(null)
        throw new Error('Session expired. Please sign in again.')
      }

      if (!response.ok) {
        throw new Error(await readError(response, `HTTP ${response.status}`))
      }

      if (!response.body) {
        throw new Error('No response body received.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          let event
          try { event = JSON.parse(trimmed) } catch { continue }

          if (event.type === 'skill_invoked') {
            setActiveToolName(`/${event.name}`)
          } else if (event.type === 'token') {
            startStreaming()
            appendChunk(event.content)
          } else if (event.type === 'tool_start') {
            const displayName = event.name.replace(/__/g, ': ')
            setActiveToolName(displayName)
            if (/graphiti|memory/i.test(event.name)) setMemoryPulseAt(Date.now())
            if (!toolCallsAccum.find(t => t.name === displayName)) {
              toolCallsAccum.push({ name: displayName, type: 'subagent' })
            }
          } else if (event.type === 'approval_required') {
            const displayName = event.name.replace(/__/g, ': ')
            setActiveToolName(`Approval: ${displayName}`)
            const approved = window.confirm(
              `Approve ${event.risk || 'risky'} ${event.kind || 'tool'} tool call?\n\n${displayName}\n\n${JSON.stringify(event.input || {}, null, 2)}`,
            )
            await resolveToolApproval(
              event.approvalId,
              approved,
              approved ? '' : 'Denied by user.',
            )
          } else if (event.type === 'config_changed') {
            setAgentConfigVersion(v => v + 1)
          } else if (event.type === 'tool_end') {
            setActiveToolName(null)
          } else if (event.type === 'done') {
            const finalToolCalls = toolCallsAccum.length ? toolCallsAccum : undefined
            if (streamingActive) {
              updateMessages(convId, prev =>
                prev.map(m => m.id === assistantId ? { ...m, streaming: false, toolCalls: finalToolCalls } : m),
              )
            } else if (finalAssistantReply) {
              updateMessages(convId, prev => [...prev, {
                id: assistantId,
                role: 'assistant',
                content: finalAssistantReply,
                streaming: false,
                toolCalls: finalToolCalls,
              }])
            }
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Agent error.')
          }
        }
      }

      if (shouldSpeakReply && playbackVoiceId && finalAssistantReply.trim()) {
        void playVoiceReply(finalAssistantReply, playbackVoiceId).catch(error => {
          setVoiceError(error instanceof Error ? error.message : 'Unable to synthesize assistant audio.')
        })
      }

      setActiveToolName(null)
      setIsThinking(false)
    } catch (err) {
      setActiveToolName(null)
      updateMessages(convId, prev =>
        prev.filter(m => m.id !== assistantId).concat({
          id: assistantId,
          role: 'assistant',
          content: `Systems error: ${err.message}`,
          streaming: false,
          isError: true,
        }),
      )
      setIsThinking(false)
    }
  }

  const sendMessage = async (text, options = {}) => {
    if (agentMode === 'agent') return sendMessageAgent(text, options)
    if (!text.trim() || isThinking || !activeConv) return

    cancelSpeechPlayback()
    setVoiceError('')
    const convId = activeConv.id
    const userMsg = { id: Date.now(), role: 'user', content: text, streaming: false }
    updateMessages(convId, prev => [...prev, userMsg])
    autoTitle(convId, text)
    setIsThinking(true)

    const assistantId = Date.now() + 1
    let mainNodeId = null
    let currentNodeId = null
    let hadNamedSubagentInCurrentCycle = false
    let mainNodeHadContentInCycle = false
    let silentToolCount = 0
    const toolCallsAccum = []
    const shouldSpeakReply = options.speakReply === true
    const playbackVoiceId = selectedVoiceId || defaultVoiceId
    let finalAssistantReply = ''

    try {
      const response = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatInput: text,
          conversation_id: convId,
        }),
      })

      if (response.status === 401) {
        setAuthUser(null)
        throw new Error('Session expired. Please sign in again.')
      }

      if (!response.ok) {
        throw new Error(await readError(response, `HTTP ${response.status}`))
      }

      if (!response.body) {
        throw new Error('No response body received.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let format = null
      let streamingActive = false

      const startStreaming = () => {
        if (streamingActive) return
        streamingActive = true
        setIsThinking(false)
        updateMessages(convId, prev => [...prev, { id: assistantId, role: 'assistant', content: '', streaming: true }])
      }

      const appendChunk = (chunk) => {
        if (!chunk) return
        finalAssistantReply += chunk
        updateMessages(convId, prev =>
          prev.map(m => m.id === assistantId ? { ...m, content: m.content + chunk } : m)
        )
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        if (format === null && buffer.trim()) {
          const first = buffer.trimStart()
          if (first.startsWith('data:')) {
            format = 'sse'
          } else {
            try {
              const probe = JSON.parse(first.split('\n')[0].trim())
              format = (probe.type === 'begin' || probe.type === 'item' || probe.type === 'end')
                ? 'n8n'
                : 'buffered'
            } catch {
              format = 'buffered'
            }
          }
        }

        if (format === 'buffered') continue

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (format === 'n8n') {
            try {
              const obj = JSON.parse(trimmed)
              const nodeId = obj.metadata?.nodeId
              const nodeName = obj.metadata?.nodeName

              if (obj.type === 'begin') {
                currentNodeId = nodeId
                if (!mainNodeId) {
                  mainNodeId = nodeId
                } else if (nodeId === mainNodeId) {
                  if (!hadNamedSubagentInCurrentCycle && !mainNodeHadContentInCycle) {
                    silentToolCount++
                  }
                  hadNamedSubagentInCurrentCycle = false
                  mainNodeHadContentInCycle = false
                  setActiveToolName(null)
                } else {
                  hadNamedSubagentInCurrentCycle = true
                  setActiveToolName(nodeName)
                  if (!toolCallsAccum.find(t => t.name === nodeName && t.type === 'subagent')) {
                    toolCallsAccum.push({ name: nodeName, type: 'subagent' })
                    if (/memory/i.test(nodeName)) setMemoryPulseAt(Date.now())
                  }
                }
              } else if (obj.type === 'end') {
                if (currentNodeId !== mainNodeId) {
                  setActiveToolName(null)
                }
              } else if (obj.type === 'item' && obj.content) {
                if (currentNodeId === mainNodeId) {
                  mainNodeHadContentInCycle = true
                  startStreaming()
                  appendChunk(obj.content)
                }
              }
            } catch { /* ignore malformed JSON lines */ }
          } else if (format === 'sse') {
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            let chunk = ''
            try {
              const parsed = JSON.parse(payload)
              chunk = parsed.text ?? parsed.output ?? parsed.content ?? ''
            } catch {
              chunk = payload
            }
            if (chunk) {
              startStreaming()
              appendChunk(chunk)
            }
          }
        }
      }

      for (let i = 0; i < silentToolCount; i++) {
        toolCallsAccum.push({ name: 'Tool call', type: 'silent' })
      }
      const finalToolCalls = toolCallsAccum.length ? toolCallsAccum : undefined

      if (streamingActive) {
        updateMessages(convId, prev =>
          prev.map(m => m.id === assistantId ? { ...m, streaming: false, toolCalls: finalToolCalls } : m)
        )
      } else {
        let reply
        try {
          const data = JSON.parse(buffer)
          reply = Array.isArray(data)
            ? (data[0]?.output ?? data[0]?.text ?? data[0]?.content ?? JSON.stringify(data[0]))
            : (data?.output ?? data?.text ?? data?.content ?? data?.message ?? JSON.stringify(data))
        } catch {
          reply = buffer.trim() || 'No response received.'
        }

        updateMessages(convId, prev => [...prev, {
          id: assistantId,
          role: 'assistant',
          content: reply,
          streaming: false,
          toolCalls: finalToolCalls,
        }])
        finalAssistantReply = reply
      }

      if (shouldSpeakReply && playbackVoiceId && finalAssistantReply.trim()) {
        void playVoiceReply(finalAssistantReply, playbackVoiceId).catch(error => {
          setVoiceError(error instanceof Error ? error.message : 'Unable to synthesize assistant audio.')
        })
      }

      setActiveToolName(null)
      setIsThinking(false)
    } catch (err) {
      setActiveToolName(null)
      updateMessages(convId, prev =>
        prev.filter(m => m.id !== assistantId).concat({
          id: assistantId,
          role: 'assistant',
          content: `Systems error: ${err.message}`,
          streaming: false,
          isError: true,
        })
      )
      setIsThinking(false)
    }
  }

  if (sessionLoading) {
    return <LoginScreen isLoading error={authError} onLogin={handleLogin} />
  }

  if (!authUser) {
    return <LoginScreen onLogin={handleLogin} isLoading={authBusy} error={authError} />
  }

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />

      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={startNewChat}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        agentMode={agentMode}
        onAgentModeChange={handleAgentModeChange}
      />

      <div className="main-column">
        <header className="app-header">
          {!sidebarOpen && (
            <button className="header-toggle" onClick={() => setSidebarOpen(true)} title="Open sidebar">
              ›
            </button>
          )}
          <div className="header-top">
            <div className="status-pip" />
            <h1 className="app-title">HestiaClaw</h1>
          </div>
          <HeaderOrb pulseAt={memoryPulseAt} />
          <p className="app-subtitle">HOME ENVIRONMENT SYSTEMS TECHNOLOGY INTELLIGENCE ASSISTANT</p>
          <div className="header-line" />
          <div className="header-actions">
            <button
              className={`header-account-btn ${settingsOpen ? 'header-account-btn--active' : ''}`}
              onClick={() => {
                setAgentPanelOpen(false)
                setSettingsOpen(open => !open)
              }}
            >
              {authUser.username}
            </button>
            <button
              className={`header-account-btn ${agentPanelOpen ? 'header-account-btn--active' : ''}`}
              onClick={() => {
                setSettingsOpen(false)
                setAgentPanelOpen(open => !open)
              }}
            >
              AGENT HARNESS
            </button>
            <button
              className={`header-account-btn ${showAutomations ? 'header-account-btn--active' : ''}`}
              onClick={() => setShowAutomations(open => !open)}
            >
              AUTOMATIONS
            </button>
            <button
              className={`header-account-btn ${showGraph ? 'header-account-btn--active' : ''}`}
              onClick={() => setShowGraph(open => !open)}
            >
              KNOWLEDGE GRAPH
            </button>
            <button className="header-logout-btn" onClick={handleLogout} disabled={authBusy}>
              LOG OUT
            </button>
          </div>
          {settingsOpen && (
            <AccountPanel
              key={authUser.username}
              user={authUser}
              isBusy={settingsBusy}
              error={settingsError}
              success={settingsSuccess}
              voiceError={voiceError}
              voiceLoading={voiceLoading}
              voices={voiceCatalog}
              selectedVoiceId={selectedVoiceId || defaultVoiceId}
              defaultVoiceId={defaultVoiceId}
              onClose={() => setSettingsOpen(false)}
              onVoiceChange={handleVoiceSelection}
              onSubmit={handleCredentialUpdate}
            />
          )}
          {agentPanelOpen && (
            <AgentPanel
              activeConversationTitle={activeConv?.title || ''}
              onClose={() => setAgentPanelOpen(false)}
              onForkConversation={forkActiveAgentConversation}
              configVersion={agentConfigVersion}
            />
          )}
        </header>

        <div className="chat-body">
          <ChatBackground pulseAt={memoryPulseAt} />
          <main className="messages-area">
            {messages.map(msg => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isThinking && <ThinkingAnimation activeTool={activeToolName} />}
            <div ref={bottomRef} />
          </main>
          <ChatInput
            onSend={sendMessage}
            onCommand={handleCommand}
            isThinking={isThinking}
            voiceDraft={voiceDraft}
            voiceError={voiceError}
            voiceState={voiceState}
            onVoiceStart={handleVoiceStart}
            onVoiceStop={handleVoiceStop}
            skills={skills}
          />
        </div>
      </div>

      {showAutomations && <AutomationsView onClose={() => setShowAutomations(false)} />}
      {showGraph && <GraphView onClose={() => setShowGraph(false)} />}
    </div>
  )
}
