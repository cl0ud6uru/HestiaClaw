const STT_SAMPLE_RATE = 16000
function joinTranscript(parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function encodeBase64FromBytes(bytes) {
  let binary = ''
  const chunkSize = 0x8000

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }

  return btoa(binary)
}

function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return input

  const sampleRateRatio = inputSampleRate / outputSampleRate
  const newLength = Math.round(input.length / sampleRateRatio)
  const result = new Float32Array(newLength)
  let offsetResult = 0
  let offsetBuffer = 0

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio)
    let accum = 0
    let count = 0

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i]
      count++
    }

    result[offsetResult] = count > 0 ? accum / count : 0
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }

  return result
}

function convertFloat32ToPcm16(input) {
  const pcm = new Int16Array(input.length)

  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  return new Uint8Array(pcm.buffer)
}

function normalizeVoiceError(error, fallback) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

export class RealtimeTranscriber {
  constructor({ getToken, fallbackTranscribe, modelId, onPartial, onStateChange }) {
    this.getToken = getToken
    this.fallbackTranscribe = fallbackTranscribe
    this.modelId = modelId
    this.onPartial = onPartial
    this.onStateChange = onStateChange
    this.audioContext = null
    this.stream = null
    this.source = null
    this.processor = null
    this.socket = null
    this.partialText = ''
    this.committedParts = []
    this.stopPromise = null
    this.stopResolve = null
    this.stopTimer = null
    this.stopping = false
    this.sessionStarted = false
    this.mediaRecorder = null
    this.recordedChunks = []
    this.pendingCleanup = false
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser.')
    }

    this.onStateChange?.('requesting')
    const token = await this.getToken('realtime_scribe')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.setupRecorder()

    this.audioContext = new window.AudioContext()
    await this.audioContext.resume()
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)
    this.source.connect(this.processor)
    this.processor.connect(this.audioContext.destination)

    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
    url.searchParams.set('model_id', this.modelId)
    url.searchParams.set('token', token)
    url.searchParams.set('language_code', 'en')
    url.searchParams.set('audio_format', 'pcm_16000')
    url.searchParams.set('commit_strategy', 'vad')
    url.searchParams.set('vad_silence_threshold_secs', '0.8')
    url.searchParams.set('min_speech_duration_ms', '120')
    url.searchParams.set('min_silence_duration_ms', '180')

    this.socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', () => reject(new Error('Unable to open realtime transcription.')), { once: true })
    })

    this.socket.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data)
        if (data.message_type === 'session_started') {
          this.sessionStarted = true
        } else if (data.message_type === 'partial_transcript') {
          this.partialText = String(data.text || '').trim()
          this.emitTranscript()
        } else if (data.message_type === 'committed_transcript' || data.message_type === 'committed_transcript_with_timestamps') {
          const text = String(data.text || '').trim()
          if (text) {
            this.committedParts.push(text)
          }
          this.partialText = ''
          this.emitTranscript()
          if (this.stopping) {
            this.finishStop()
          }
        } else if (String(data.message_type || '').endsWith('_error')) {
          throw new Error(data.message || 'Realtime transcription failed.')
        }
      } catch (error) {
        this.finishStop(error)
      }
    })

    this.socket.addEventListener('close', () => {
      if (this.stopping) {
        this.finishStop()
      }
    })

    this.processor.onaudioprocess = event => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.stopping || !this.sessionStarted) return

      const input = event.inputBuffer.getChannelData(0)
      const downsampled = downsampleBuffer(input, this.audioContext.sampleRate, STT_SAMPLE_RATE)
      const pcmBytes = convertFloat32ToPcm16(downsampled)

      if (!pcmBytes.byteLength) return

      this.socket.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: encodeBase64FromBytes(pcmBytes),
        sample_rate: STT_SAMPLE_RATE,
        commit: false,
        previous_text: joinTranscript(this.committedParts),
      }))
    }

    this.onStateChange?.('recording')
  }

  emitTranscript() {
    this.onPartial?.(joinTranscript([...this.committedParts, this.partialText]))
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise

    this.stopping = true
    this.onStateChange?.('transcribing')
    this.processor && (this.processor.onaudioprocess = null)

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: STT_SAMPLE_RATE,
        commit: false,
        previous_text: joinTranscript(this.committedParts),
      }))
    }

    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve
      this.stopTimer = window.setTimeout(() => this.finishStop(), 2200)
    })

    const [result] = await Promise.all([
      this.stopPromise,
      this.stopRecorder(),
    ])

    if (!result.text && !result.error && this.fallbackTranscribe) {
      const fallbackText = await this.transcribeFallback().catch(error => {
        return Promise.reject(new Error(normalizeVoiceError(error, 'Unable to transcribe recorded audio.')))
      })
      this.cleanup()
      return { text: fallbackText, error: '' }
    }

    this.cleanup()
    return result
  }

  cancel() {
    this.stopping = true
    if (this.stopResolve) {
      this.finishStop()
      return
    }
    void this.stopRecorder().finally(() => this.cleanup())
  }

  finishStop(error = null) {
    if (!this.stopResolve) {
      return
    }

    window.clearTimeout(this.stopTimer)
    const resolve = this.stopResolve
    this.stopResolve = null
    const transcript = joinTranscript([...this.committedParts, this.partialText])
    this.pendingCleanup = true
    resolve({
      text: transcript,
      error: error ? normalizeVoiceError(error, 'Unable to transcribe speech.') : '',
    })
  }

  cleanup() {
    this.onStateChange?.('idle')
    this.sessionStarted = false
    this.pendingCleanup = false
    this.mediaRecorder = null

    if (this.processor) {
      this.processor.disconnect()
      this.processor = null
    }

    if (this.source) {
      this.source.disconnect()
      this.source = null
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop()
      }
      this.stream = null
    }

    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close()
    }
    this.socket = null

    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }

    this.recordedChunks = []
  }

  setupRecorder() {
    if (!window.MediaRecorder) return

    try {
      this.recordedChunks = []
      this.mediaRecorder = new MediaRecorder(this.stream)
      this.mediaRecorder.addEventListener('dataavailable', event => {
        if (event.data?.size) {
          this.recordedChunks.push(event.data)
        }
      })
      this.mediaRecorder.start(250)
    } catch {
      this.mediaRecorder = null
      this.recordedChunks = []
    }
  }

  async transcribeFallback() {
    if (!this.recordedChunks.length) return ''

    const mimeType = this.recordedChunks[0]?.type || this.mediaRecorder?.mimeType || 'audio/webm'
    const blob = new Blob(this.recordedChunks, { type: mimeType })
    if (blob.size < 512) return ''

    return this.fallbackTranscribe(blob)
  }

  async stopRecorder() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return

    await new Promise(resolve => {
      this.mediaRecorder.addEventListener('stop', resolve, { once: true })
      this.mediaRecorder.stop()
    })
  }
}

export function getVoiceStorageKey(userId) {
  return `hestia-voice:user:${userId}`
}
