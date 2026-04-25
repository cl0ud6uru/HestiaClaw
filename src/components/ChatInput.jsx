import { useCallback, useEffect, useRef, useState } from 'react'
import './ChatInput.css'

const BUILTIN_COMMANDS = [
  { name: 'new-chat', description: 'Start a new conversation', builtin: true },
  { name: 'approvals', description: 'Toggle tool approvals on/off (or /approvals on|off)' },
]

export default function ChatInput({
  onSend,
  onCommand,
  isThinking,
  voiceDraft,
  voiceError,
  voiceState,
  onVoiceStart,
  onVoiceStop,
  skills,
}) {
  const [value, setValue] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const textareaRef = useRef(null)
  const pointerActiveRef = useRef(false)

  useEffect(() => {
    if (!isThinking && voiceState === 'idle') textareaRef.current?.focus()
  }, [isThinking, voiceState])

  // Slash command palette logic
  const slashQuery = !isThinking && value.startsWith('/') ? value.slice(1).toLowerCase() : null
  const paletteItems = slashQuery !== null ? [
    ...BUILTIN_COMMANDS.filter(c => slashQuery === '' || c.name.startsWith(slashQuery)),
    ...(skills || []).filter(s =>
      s.userInvocable !== false &&
      (slashQuery === '' || s.name.startsWith(slashQuery) || s.description.toLowerCase().includes(slashQuery))
    ),
  ] : []

  const prevSlashQueryRef = useRef(null)
  if (prevSlashQueryRef.current !== slashQuery) {
    prevSlashQueryRef.current = slashQuery
    setPaletteIndex(0)
  }

  const selectPaletteItem = useCallback((item) => {
    if (item.builtin) {
      onCommand?.(item.name)
      setValue('')
    } else if (item.argumentHint) {
      setValue(`/${item.name} ${item.argumentHint}`)
      setTimeout(() => textareaRef.current?.focus(), 0)
    } else {
      onSend(`/${item.name}`)
      setValue('')
    }
  }, [onCommand, onSend])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || isThinking || voiceState !== 'idle') return
    onSend(trimmed)
    setValue('')
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }, 0)
  }

  const handleKeyDown = (e) => {
    if (paletteItems.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex(i => (i + 1) % paletteItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex(i => (i - 1 + paletteItems.length) % paletteItems.length); return }
      if (e.key === 'Tab') { e.preventDefault(); selectPaletteItem(paletteItems[paletteIndex]); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectPaletteItem(paletteItems[paletteIndex]); return }
      if (e.key === 'Escape') { setValue(''); return }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleChange = (e) => {
    setValue(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }

  const handleVoicePointerDown = async (e) => {
    if (isThinking || voiceState !== 'idle' || value.trim()) return
    pointerActiveRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    await onVoiceStart()
  }

  const handleVoicePointerUp = async () => {
    if (!pointerActiveRef.current) return
    pointerActiveRef.current = false
    await onVoiceStop()
  }

  const displayValue = voiceState === 'idle' ? value : voiceDraft
  const isVoiceBusy = voiceState !== 'idle'
  const isRecording = voiceState === 'recording'
  const sendDisabled = !value.trim() || isThinking || isVoiceBusy
  const micDisabled = isThinking || isVoiceBusy || Boolean(value.trim())

  return (
    <div className="input-section">
      <div className="input-hud">
        <span className="ihud-corner tl" />
        <span className="ihud-corner tr" />
        <span className="ihud-corner bl" />
        <span className="ihud-corner br" />

        {paletteItems.length > 0 && (
          <div className="slash-palette">
            {paletteItems.map((item, i) => (
              <button
                key={item.builtin ? `__${item.name}` : item.name}
                className={`slash-palette__item ${i === paletteIndex ? 'slash-palette__item--active' : ''}`}
                type="button"
                onMouseEnter={() => setPaletteIndex(i)}
                onClick={() => selectPaletteItem(item)}
              >
                <span className="slash-palette__name">/{item.name}</span>
                <span className="slash-palette__desc">{item.description}</span>
              </button>
            ))}
          </div>
        )}

        <div className="input-row">
          <div className="input-prefix">
            <div className={`input-dot ${isThinking ? 'input-dot--busy' : 'input-dot--ready'}`} />
          </div>

          <textarea
            ref={textareaRef}
            className="chat-textarea"
            value={displayValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              isThinking
                ? 'Processing…'
                : isRecording
                  ? 'Listening…'
                  : voiceState === 'transcribing'
                    ? 'Transcribing…'
                    : 'Enter query… (/ for commands)'
            }
            disabled={isThinking || isVoiceBusy}
            rows={1}
          />

          <button
            className={`mic-btn ${isRecording ? 'mic-btn--active' : ''} ${micDisabled ? 'mic-btn--disabled' : ''}`}
            type="button"
            onPointerDown={handleVoicePointerDown}
            onPointerUp={handleVoicePointerUp}
            onPointerCancel={handleVoicePointerUp}
            onLostPointerCapture={handleVoicePointerUp}
            aria-label="Hold to talk"
            title={value.trim() ? 'Clear typed text to use voice input' : 'Hold to talk'}
            disabled={micDisabled}
          >
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" stroke="currentColor">
              <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v3" />
              <path d="M8 21h8" />
            </svg>
          </button>

          <button
            className={`send-btn ${sendDisabled ? 'send-btn--disabled' : ''}`}
            onClick={handleSubmit}
            disabled={sendDisabled}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" stroke="currentColor">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {(voiceError || isVoiceBusy) && (
          <div className={`voice-status ${voiceError ? 'voice-status--error' : ''}`}>
            {voiceError || (isRecording ? 'VOICE CHANNEL OPEN — RELEASE TO SEND' : 'FINALIZING TRANSCRIPT…')}
          </div>
        )}
      </div>

      <div className="input-footer">
        <span>HESTIACLAW</span>
        <span className={(isThinking || isVoiceBusy) ? 'status-busy' : 'status-ready'}>
          {isThinking ? '● PROCESSING' : isRecording ? '● LISTENING' : voiceState === 'transcribing' ? '● TRANSCRIBING' : '● READY'}
        </span>
      </div>
    </div>
  )
}
