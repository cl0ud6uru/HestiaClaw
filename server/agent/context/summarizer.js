const SUMMARIZE_SYSTEM = 'You are a concise conversation summarizer. Output a single paragraph under 300 words. Preserve key facts, decisions, user preferences, and outcomes. Omit raw tool output details.'

export function estimateTokens(value) {
  return Math.ceil(String(value ?? '').length / 4)
}

export async function generateSummary(provider, messages) {
  const transcript = messages.map(m => {
    let text
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      text = m.content.map(p => p.text || p.content || '').filter(Boolean).join(' ')
    } else {
      text = JSON.stringify(m.content || '')
    }
    const role = m.role || m.type || 'unknown'
    return `${role}: ${text.slice(0, 600)}`
  }).join('\n')

  try {
    return await provider.complete(
      [{ role: 'user', content: `Summarize this conversation history:\n\n${transcript}` }],
      { system: SUMMARIZE_SYSTEM, maxTokens: 400 },
    )
  } catch {
    // Fallback to mechanical truncation if LLM call fails
    return transcript.slice(0, 1200)
  }
}
