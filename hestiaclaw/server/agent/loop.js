import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAIProvider } from './providers/openai.js'
import { summarizeToolResult } from './context/tool-result-summarizer.js'
import { generateSummary } from './context/summarizer.js'

const MAX_ITERATIONS = 25
const DEFAULT_CONTEXT_MAX_MESSAGES = 40

export function readDailyNotes(notesDir) {
  if (!notesDir) return ''
  const now = new Date()
  const todayStamp = now.toISOString().slice(0, 10)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStamp = yesterday.toISOString().slice(0, 10)
  const parts = []
  for (const [label, stamp] of [['Yesterday', yesterdayStamp], ['Today', todayStamp]]) {
    try {
      const content = readFileSync(join(notesDir, `${stamp}.md`), 'utf8').trim()
      if (content) parts.push(`### ${label} (${stamp})\n${content}`)
    } catch { /* file may not exist — skip silently */ }
  }
  return parts.join('\n\n')
}

/**
 * Emit a single NDJSON line to the response stream. We attempt an immediate
 * flush after every event so reverse proxies (notably HA ingress / nginx) can't
 * sit on time-sensitive events like `approval_required`.
 */
function emit(res, event) {
  try {
    res.write(JSON.stringify(event) + '\n')
    res.flush?.()
  } catch { /* response may already be closed */ }
}

export function startStreamingResponse(res, contentType = 'application/x-ndjson') {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.socket?.setNoDelay?.(true)
  res.socket?.setKeepAlive?.(true)
  res.flushHeaders?.()
}

/**
 * Run the agent loop for one user turn. Streams NDJSON events to res:
 *   { type: 'token',      content }
 *   { type: 'tool_start', id, name, input }
 *   { type: 'tool_end',   id, name, result?, error? }
 *   { type: 'done' }
 *   { type: 'error',      message }
 */
const MEMORY_BUDGET = { pinned: 3000, notes: 1500, recall: 2000 }

function buildEffectiveSystemPrompt(systemPrompt, summary, skills = [], memorySummary = '', dailyNotes = '', activeMemory = '') {
  memorySummary = (memorySummary ?? '').slice(0, MEMORY_BUDGET.pinned)
  dailyNotes    = (dailyNotes    ?? '').slice(0, MEMORY_BUDGET.notes)
  activeMemory  = (activeMemory  ?? '').slice(0, MEMORY_BUDGET.recall)

  let prompt = systemPrompt

  if (memorySummary) {
    prompt += `\n\n## Pinned Memory\nThese are your confirmed high-confidence long-term memories. Trust these unless directly contradicted.\n\n${memorySummary}`
  }

  if (dailyNotes) {
    prompt += `\n\n## Daily Notes\nEpisodic log of recent activity:\n\n${dailyNotes}`
  }

  if (activeMemory) {
    prompt += `\n\n## Active Memory Recall\nRelevant memories retrieved for this turn:\n\n${activeMemory}`
  }

  const SKILL_INLINE_THRESHOLD = 600
  const invocableSkills = skills.filter(s => !s.disableModelInvocation)
  const inlineSkills   = invocableSkills.filter(s => s.content.length <= SKILL_INLINE_THRESHOLD)
  const onDemandSkills = invocableSkills.filter(s => s.content.length >  SKILL_INLINE_THRESHOLD)

  if (inlineSkills.length > 0) {
    const inlineSection = inlineSkills
      .map(s => `### /${s.name}\n${s.description}\n\n${s.content}`)
      .join('\n\n')
    prompt += `\n\n## Skills\n\nUse these when the user's request matches. Follow skill instructions exactly.\n\n${inlineSection}`
  }
  if (onDemandSkills.length > 0) {
    const menu = onDemandSkills.map(s => `- /${s.name}: ${s.description}`).join('\n')
    prompt += `\n\n## Extended Skills (load before use)\nCall \`invoke_skill\` with one of the skill names listed below to load full instructions before executing. Do not call \`invoke_skill\` with names not on this list — proceed with the built-in policies above instead.\n\n${menu}`
  }

  if (summary) prompt += `\n\nConversation summary so far:\n${summary}`
  return prompt
}

export async function runAgentLoop(res, {
  provider,
  session,
  registry,
  systemPrompt,
  conversationId,
  userMessage,
  approvals,
  events,
  settings = {},
  skills = [],
  activatedSkill = null,
  memorySummary = '',
  dailyNotes = '',
  activeMemory = '',
  allowedTools = null,
  toolPolicy = null,
  source = 'chat',
}) {
  const isAnthropic = provider instanceof AnthropicProvider
  const isOpenAI = provider instanceof OpenAIProvider
  const runId = session.startRun({
    conversationId,
    provider: provider.name,
    model: provider.model,
    userMessage,
  })

  emit(res, { type: 'run_start', id: runId })
  await events?.emit('run_start', { runId, conversationId, provider: provider.name, model: provider.model })
  session.recordRunEvent(runId, 'run_start', {
    provider: provider.name,
    model: provider.model,
    toolCount: registry.size,
  })

  // Load bounded history and append the new user message
  const context = session.getContext(conversationId, {
    maxMessages: settings.contextMaxMessages || DEFAULT_CONTEXT_MAX_MESSAGES,
    compactionEnabled: settings.compactionEnabled !== false,
  })

  // Upgrade to LLM summary if unsummarized messages exist behind the kept window
  if (context.needsSummary) {
    try {
      const llmSummary = await generateSummary(provider, context.rowsToSummarize)
      session.saveSummary(conversationId, llmSummary, context.summarizeThroughId)
      context.summary = llmSummary
    } catch (err) {
      console.warn('[agent] LLM summary failed, using existing summary:', err.message)
    }
  }

  const effectiveSystemPrompt = buildEffectiveSystemPrompt(systemPrompt, context.summary, skills, memorySummary, dailyNotes, activeMemory)

  if (activatedSkill) {
    session.recordRunEvent(runId, 'skill_activated', activatedSkill)
  }
  const injectedSkillNames = skills.filter(s => !s.disableModelInvocation).map(s => s.name)
  if (injectedSkillNames.length > 0) {
    session.recordRunEvent(runId, 'skill_injected', { skills: injectedSkillNames })
  }

  if (context.summary) {
    emit(res, { type: 'context_summary', messageCount: context.totalMessages, keptMessages: context.messages.length })
    session.recordRunEvent(runId, 'context_summary', {
      messageCount: context.totalMessages,
      keptMessages: context.messages.length,
      summaryLength: context.summary.length,
      llmSummary: context.needsSummary,
    })
  }
  const history = context.messages
  const userTurn = { role: 'user', content: userMessage }
  const messages = [...history, userTurn]

  // Tool definitions: prefer toolPolicy (per-source visibility + allowedSources +
  // approval modes); fall back to legacy allowedTools glob list when no policy.
  // For OpenAI we send the full tool list and constrain via tool_choice.allowed_tools
  // so the cached prefix stays stable across turns.
  let tools, allowedToolNames = null
  if (toolPolicy) {
    const allMeta = registry.listTools()
    if (isOpenAI) {
      const cs = toolPolicy.cacheStableDefinitions(allMeta, source)
      tools = cs.definitions
      allowedToolNames = cs.allowedNames
    } else {
      tools = toolPolicy.visibleDefinitions(allMeta, source)
    }
  } else {
    tools = registry.getDefinitions(allowedTools)
  }

  let iterations = 0
  // These are the new messages generated this turn (for storage)
  const newMessages = [userTurn]

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++

      // Collect content and tool calls from this provider cycle
      let textContent = ''
      const toolCallsThisCycle = []
      const thinkingBlocksThisCycle = []
      const reasoningItemsThisCycle = []
      await events?.emit('model_start', { runId, iteration: iterations })
      session.recordRunEvent(runId, 'model_start', { iteration: iterations })

      const streamOptions = {
        system: effectiveSystemPrompt,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {}),
        ...(settings.thinkingBudget ? { thinkingBudget: settings.thinkingBudget } : {}),
        ...(allowedToolNames ? { allowedToolNames } : {}),
      }

      for await (const event of provider.stream(messages, tools, streamOptions)) {
        if (event.type === 'token') {
          textContent += event.content
          emit(res, { type: 'token', content: event.content })
        } else if (event.type === 'tool_call') {
          toolCallsThisCycle.push(event)
          emit(res, { type: 'tool_start', id: event.id, name: event.name, input: event.input })
          await events?.emit('tool_start', { runId, toolCall: event })
          session.recordRunEvent(runId, 'tool_start', { id: event.id, name: event.name, input: event.input })
          session.startToolCall(runId, event)
        } else if (event.type === 'thinking_block') {
          thinkingBlocksThisCycle.push({ type: 'thinking', thinking: event.content })
        } else if (event.type === 'reasoning_item') {
          reasoningItemsThisCycle.push(event.item)
        }
        // thinking_token events are not forwarded to the client — preserved in history only
      }
      session.recordRunEvent(runId, 'model_end', {
        iteration: iterations,
        outputLength: textContent.length,
        toolCallCount: toolCallsThisCycle.length,
      })
      await events?.emit('model_end', {
        runId,
        iteration: iterations,
        outputLength: textContent.length,
        toolCallCount: toolCallsThisCycle.length,
      })

      if (toolCallsThisCycle.length === 0) {
        // No tool calls — conversation turn is complete
        const assistantMsg = { role: 'assistant', content: textContent }
        newMessages.push(assistantMsg)
        break
      }

      // Build the assistant turn for this cycle and append to messages
      // Note: OpenAI Responses API returns an array of items; Anthropic returns a single object.
      let assistantTurn
      if (isAnthropic) {
        const contentParts = []
        // Thinking blocks must precede text and tool_use blocks
        for (const tb of thinkingBlocksThisCycle) contentParts.push(tb)
        if (textContent) contentParts.push({ type: 'text', text: textContent })
        for (const tc of toolCallsThisCycle) {
          contentParts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
        assistantTurn = AnthropicProvider.buildAssistantTurn(contentParts)
        messages.push(assistantTurn)
      } else if (isOpenAI) {
        assistantTurn = OpenAIProvider.buildAssistantTurn(textContent, toolCallsThisCycle, reasoningItemsThisCycle)
        messages.push(...assistantTurn)
      } else {
        assistantTurn = { role: 'assistant', content: textContent }
        messages.push(assistantTurn)
      }

      // Execute tools and collect results
      const toolResults = []
      for (const tc of toolCallsThisCycle) {
        let result, hasError
        const toolMetadata = registry.get(tc.name)
        const requestApproval = async ({
          name = tc.name,
          input = tc.input,
          risk = toolMetadata?.risk || 'medium',
          kind = toolMetadata?.kind || 'write',
          toolCallId = tc.id,
        } = {}) => {
          if (!approvals) {
            throw new Error(`Tool "${name}" requires approval but approvals are not available.`)
          }
          const approval = approvals.request({
            runId,
            toolCallId,
            name,
            input,
            risk,
            kind,
          })
          emit(res, {
            type: 'approval_required',
            approvalId: approval.id,
            id: toolCallId,
            name,
            input,
            risk,
            kind,
            timeoutMs: approvals.timeoutMs,
          })
          session.recordRunEvent(runId, 'approval_required', { approvalId: approval.id, id: toolCallId, name })
          await events?.emit('approval_required', {
            runId,
            approvalId: approval.id,
            toolCall: { ...tc, id: toolCallId, name, input },
          })
          const decision = await approval.promise
          session.recordRunEvent(runId, 'approval_resolved', {
            approvalId: approval.id,
            id: toolCallId,
            name,
            approved: decision.approved,
            reason: decision.reason,
          })
          if (!decision.approved) {
            throw new Error(decision.reason || `Tool "${name}" was denied by policy.`)
          }
          return decision
        }
        try {
          // Source / policy gate: refuse calls the policy says shouldn't
          // execute from this source (model may try anyway when using OpenAI
          // allowed_tools mode, since tools array contains the full list).
          if (toolPolicy && toolMetadata) {
            const gate = toolPolicy.canExecute(toolMetadata, source)
            if (!gate.ok) {
              throw new Error(`Tool "${tc.name}" not permitted from ${source}: ${gate.reason}`)
            }
          }
          const policyApproval = toolPolicy && toolMetadata
            ? toolPolicy.approvalRequired(toolMetadata, source)
            : toolMetadata?.requiresApproval === true
          if (policyApproval) {
            await requestApproval({
              name: tc.name,
              input: tc.input,
              risk: toolMetadata.risk,
              kind: toolMetadata.kind,
            })
          }
          result = await registry.execute(tc.name, tc.input, {
            conversationId,
            source,
            approvalsAvailable: Boolean(approvals),
            requestApproval,
          })
          hasError = false
        } catch (err) {
          result = `Error: ${err.message}`
          hasError = true
        }
        const modelResult = summarizeToolResult(tc.name, result)
        toolResults.push({ id: tc.id, name: tc.name, result: modelResult })
        session.finishToolCall(runId, {
          id: tc.id,
          result: hasError ? null : result,
          error: hasError ? result : null,
        })
        session.recordRunEvent(runId, 'tool_end', {
          id: tc.id,
          name: tc.name,
          ok: !hasError,
          resultLength: String(result).length,
        })
        await events?.emit('tool_end', { runId, toolCall: tc, ok: !hasError, result })
        emit(res, { type: 'tool_end', id: tc.id, name: tc.name, ...(hasError ? { error: result } : {}) })
      }

      // Append tool results to messages for the next cycle
      if (isAnthropic) {
        const toolResultTurn = AnthropicProvider.buildToolResultTurn(toolResults)
        messages.push(toolResultTurn)
        newMessages.push(assistantTurn, toolResultTurn)
      } else if (isOpenAI) {
        const toolResultItems = OpenAIProvider.buildToolResultTurn(toolResults)
        messages.push(...toolResultItems)
        newMessages.push(...assistantTurn, ...toolResultItems)
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      session.finishRun(runId, 'error', 'Agent reached maximum iteration limit.')
      await events?.emit('run_error', { runId, message: 'Agent reached maximum iteration limit.' })
      emit(res, { type: 'error', message: 'Agent reached maximum iteration limit.' })
    } else {
      session.finishRun(runId, 'completed')
      await events?.emit('run_done', { runId })
    }
  } catch (err) {
    session.recordRunEvent(runId, 'run_error', { message: err.message || 'Agent error.' })
    session.finishRun(runId, 'error', err.message || 'Agent error.')
    await events?.emit('run_error', { runId, message: err.message || 'Agent error.' })
    emit(res, { type: 'error', message: err.message || 'Agent error.' })
  }

  // Persist the new messages to SQLite
  try {
    session.appendMessages(conversationId, newMessages)
  } catch (err) {
    console.error('[agent] Failed to persist messages:', err.message)
  }

  emit(res, { type: 'done' })
}
