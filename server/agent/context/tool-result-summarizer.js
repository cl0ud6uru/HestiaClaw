const CAPS = {
  default: 1200,
  error:    600,
  ha:      1000,
  memory:  1200,
  search:  1200,
}

export function summarizeToolResult(name, result) {
  const text = String(result ?? '')
  const cap = pickCap(name, text)
  if (text.length <= cap) return text

  const label = labelFor(name)
  return `[${label} truncated: ${text.length} chars — showing first ${cap}]\n${text.slice(0, cap)}`
}

function pickCap(name, text) {
  if (/error/i.test(text.slice(0, 80)))      return CAPS.error
  if (/home.assistant|ha_/i.test(name))       return CAPS.ha
  if (/graphiti|memory/i.test(name))          return CAPS.memory
  if (/search|web/i.test(name))               return CAPS.search
  return CAPS.default
}

function labelFor(name) {
  if (/home.assistant|ha_/i.test(name)) return 'Home Assistant result'
  if (/graphiti|memory/i.test(name))    return 'Memory result'
  if (/search|web/i.test(name))         return 'Search result'
  return 'Tool result'
}
