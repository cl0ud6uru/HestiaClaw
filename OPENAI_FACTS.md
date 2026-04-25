# OpenAI API — Reference Facts (April 2026)

## Current models

| Model ID | Role | Notes |
|----------|------|-------|
| `gpt-5.4` | Flagship | Complex professional work + coding; all reasoning effort levels |
| `gpt-5.4-mini` | Fast / affordable | High-volume; full reasoning support; **recommended default** |
| `gpt-5.4-nano` | Cheapest | Simple high-volume; low reasoning budget |
| `gpt-5.5` | Bleeding edge | Live in ChatGPT/Codex; API access TBA |
| `gpt-4.1` | Legacy (API only) | Great at coding; retired from ChatGPT Feb 2026, API still works |
| `gpt-4.1-mini` | Legacy (API only) | Same retirement status as gpt-4.1 |

**Deprecated / do not use:** `gpt-4o`, `o3`, `o4-mini` — succeeded by the GPT-5 series.

---

## Chat Completions vs Responses API

OpenAI now offers two primary generation APIs:

| | Chat Completions | Responses API |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /v1/responses` |
| Status | Supported indefinitely (industry standard) | Recommended for new projects |
| Cache hit rate | Baseline | 40–80% better |
| Stateful turns | Manual (`messages` array) | `store: true` — server preserves context |
| Reasoning | `reasoning_effort` top-level param | `reasoning.effort` nested param |
| Reasoning summaries | No | Yes (at no extra cost) |
| Tool calls + reasoning | Limited on `reasoning_effort: 'none'` with GPT-5.4+ | Full support |
| SDK method | `client.chat.completions.create()` | `client.responses.create()` |

> **We now use the Responses API** (`client.responses.create()`). The provider converts old Chat
> Completions history (role:'tool', tool_calls:[]) to Responses format on the fly, so existing
> conversations are not broken. New turns are stored in Responses format.

---

## Reasoning effort (Chat Completions)

Pass as a **top-level parameter** in the request body:

```json
{ "reasoning_effort": "none" | "low" | "medium" | "high" | "xhigh" }
```

- Default for GPT-5.2+ is `"none"` (lowest latency).
- Reasoning tokens are not billed separately in Chat Completions.
- **`"none"` disables tool calling on GPT-5.4+** — use `"low"` or higher when tools are active.
- `"xhigh"` was added in GPT-5.2; earlier models only support up to `"high"`.

## Reasoning effort (Responses API)

```json
{ "reasoning": { "effort": "low", "summary": "auto" } }
```

`"summary": "auto"` enables free reasoning summaries streamed alongside output.

---

## Streaming

Both APIs support streaming. Chat Completions streaming is unchanged (delta chunks).
Responses API adds:
- `response.reasoning_text.delta` events for reasoning token deltas
- **Background mode** — long-running tasks avoid HTTP timeouts

---

## Node.js SDK

Package: `openai` (npm)

```js
// Chat Completions (current)
client.chat.completions.create({ model, messages, tools, stream: true, reasoning_effort: 'medium' })

// Responses API (future migration path)
client.responses.create({ model, input, tools, stream: true, reasoning: { effort: 'medium', summary: 'auto' } })
```

---

## Agent Skills — cross-platform standard (Dec 2025 / agentskills.io)

Originally published by Anthropic; adopted by OpenAI Codex, GitHub Copilot, Cursor, JetBrains Junie, Google Gemini CLI, and 30+ others as of early 2026.

A **skill** = directory containing `SKILL.md` + optional `scripts/`, `references/`, `assets/`.

### SKILL.md frontmatter

```yaml
---
name: my-skill-name          # lowercase-hyphenated, max 64 chars, must match folder name
description: >               # max 1024 chars — describe WHAT it does AND WHEN to invoke it
  One-sentence summary used by the agent to decide when to activate this skill.
argument-hint: <placeholder> # optional — shown after /skill-name in the palette
user-invocable: true         # true = appears as a /slash-command (default true)
disable-model-invocation: false  # true = only explicit /invocation, no auto-activation
---

Markdown body — the actual instructions/prompt the agent receives when skill is active.
```

### Invocation

- **Slash command**: `/skill-name` in chat input — explicit
- **Implicit**: agent auto-activates when it detects a matching task (unless `disable-model-invocation: true`)

---

## Key quirks to keep in mind

1. **Tool name length cap is still 64 chars** — enforced on both definitions and messages.
2. **Responses API tool definitions are flattened** — `{ type:'function', name, description, parameters }` not `{ type:'function', function: { name, ... } }`.
3. **Tool calls are `response.output_item.done` events** — wait for the done event (not delta events) to get the complete name + call_id + arguments for a function_call item.
4. **`reasoning` + tools** — the Responses API may still reject `reasoning: { effort }` combined with tools on some models; we drop it when tools are active to be safe.
5. **Context window**: gpt-5.4 and gpt-5.4-mini both support up to 1 M tokens input.
6. **History format**: new turns stored as Responses API items (`type: 'function_call'`, `type: 'function_call_output'`). Old Chat Completions format (`role: 'tool'`, `tool_calls: []`) is auto-converted on read.
