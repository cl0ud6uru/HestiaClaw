import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSystemPrompt } from '../config.js'
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/default-system-prompt.js'

test('resolveSystemPrompt: returns built-in prompt by default with empty config', () => {
  const out = resolveSystemPrompt({}, {})
  assert.equal(out.systemPromptLocked, true)
  assert.equal(out.systemPromptSource, 'builtin')
  assert.equal(out.systemPrompt, DEFAULT_SYSTEM_PROMPT.trim())
})

test('resolveSystemPrompt: built-in prompt wins even when config.systemPrompt is set (locked by default)', () => {
  const out = resolveSystemPrompt({ systemPrompt: 'CUSTOM PROMPT FROM CONFIG' }, {})
  assert.equal(out.systemPromptLocked, true)
  assert.equal(out.systemPromptSource, 'builtin')
  assert.equal(out.systemPrompt, DEFAULT_SYSTEM_PROMPT.trim())
  assert.ok(!out.systemPrompt.includes('CUSTOM PROMPT FROM CONFIG'))
})

test('resolveSystemPrompt: harness.systemPromptLocked=false unlocks and uses config prompt', () => {
  const out = resolveSystemPrompt({
    systemPrompt: 'CUSTOM PROMPT FROM CONFIG',
    harness: { systemPromptLocked: false },
  }, {})
  assert.equal(out.systemPromptLocked, false)
  assert.equal(out.systemPromptSource, 'config')
  assert.equal(out.systemPrompt, 'CUSTOM PROMPT FROM CONFIG')
})

test('resolveSystemPrompt: HESTIA_SYSTEM_PROMPT_LOCKED=false unlocks via env', () => {
  const out = resolveSystemPrompt(
    { systemPrompt: 'ENV UNLOCK PROMPT' },
    { HESTIA_SYSTEM_PROMPT_LOCKED: 'false' },
  )
  assert.equal(out.systemPromptLocked, false)
  assert.equal(out.systemPromptSource, 'config')
  assert.equal(out.systemPrompt, 'ENV UNLOCK PROMPT')
})

test('resolveSystemPrompt: unlocked but no config.systemPrompt falls back to built-in', () => {
  const out = resolveSystemPrompt(
    { harness: { systemPromptLocked: false } },
    {},
  )
  assert.equal(out.systemPromptLocked, false)
  assert.equal(out.systemPromptSource, 'builtin')
  assert.equal(out.systemPrompt, DEFAULT_SYSTEM_PROMPT.trim())
})

test('resolveSystemPrompt: unlocked with whitespace-only config.systemPrompt falls back to built-in', () => {
  const out = resolveSystemPrompt(
    { systemPrompt: '   \n  ', harness: { systemPromptLocked: false } },
    {},
  )
  assert.equal(out.systemPromptSource, 'builtin')
})

test('built-in prompt contains the critical policy sections', () => {
  const text = DEFAULT_SYSTEM_PROMPT
  assert.match(text, /## Memory Architecture/)
  assert.match(text, /Graphiti vs Home Assistant/)
  assert.match(text, /## Home Assistant \(native ha-mcp tools\)/)
  assert.match(text, /hestia_user/)
  assert.match(text, /hestia_home/)
})

test('built-in prompt uses neutral wording for optional Graphiti tools', () => {
  // The prompt should not assume Graphiti is always installed.
  assert.match(DEFAULT_SYSTEM_PROMPT, /When Graphiti tools are available/)
  // Home Assistant guidance now points at native ha-mcp tool names directly.
  assert.match(DEFAULT_SYSTEM_PROMPT, /home-assistant__ha_search_entities/)
  assert.match(DEFAULT_SYSTEM_PROMPT, /home-assistant__ha_call_service/)
})
