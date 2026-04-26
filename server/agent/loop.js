import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAIProvider } from './providers/openai.js'

const MAX_ITERATIONS = 10
const DEFAULT_CONTEXT_MAX_MESSAGES = 40

/**
 * Emit a single NDJSON line to the response stream.
 */
function emit(res, event) {
  res.write(JSON.stringify(event) + '\n')
}

/**
 * Run the agent loop for one user turn. Streams NDJSON events to res:
 *   { type: 'token',      content }
 *   { type: 'tool_start', id, name, input }
 *   { type: 'tool_end',   id, name, result?, error? }
 *   { type: 'done' }
 *   { type: 'error',      message }
 */
function buildEffectiveSystemPrompt(systemPrompt, summary, skills = [], memorySummary = '', activeMemory = '') {
  let prompt = systemPrompt

  if (memorySummary) {
    prompt += `\n\n## Pinned Memory\nThese are your confirmed high-confidence long-term memories. Trust these unless directly contradicted.\n\n${memorySummary}`
  }

  if (activeMemory) {
    prompt += `\n\n## Active Memory Recall\nRelevant memories retrieved for this turn:\n\n${activeMemory}`
  }

  const invocableSkills = skills.filter(s => !s.disableModelInvocation)
  if (invocableSkills.length > 0) {
    const skillsSection = invocableSkills
      .map(s => `### /${s.name}\n${s.description}\n\n${s.content}`)
      .join('\n\n')
    prompt += `\n\n## Skills\n\nUse these pre-defined skills when the user's request matches their description. Follow the skill instructions exactly.\n\n${skillsSection}`
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
  memorySummary = '',
  activeMemory = '',
  allowedTools = null,
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
  const effectiveSystemPrompt = buildEffectiveSystemPrompt(systemPrompt, context.summary, skills, memorySummary, activeMemory)
  if (context.summary) {
    emit(res, { type: 'context_summary', messageCount: context.totalMessages, keptMessages: context.messages.length })
    session.recordRunEvent(runId, 'context_summary', {
      messageCount: context.totalMessages,
      keptMessages: context.messages.length,
      summaryLength: context.summary.length,
    })
  }
  const history = context.messages
  const userTurn = { role: 'user', content: userMessage }
  const messages = [...history, userTurn]

  const tools = registry.getDefinitions(allowedTools)

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
      await events?.emit('model_start', { runId, iteration: iterations })
      session.recordRunEvent(runId, 'model_start', { iteration: iterations })

      const streamOptions = {
        system: effectiveSystemPrompt,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {}),
        ...(settings.thinkingBudget ? { thinkingBudget: settings.thinkingBudget } : {}),
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
        assistantTurn = OpenAIProvider.buildAssistantTurn(textContent, toolCallsThisCycle)
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
        try {
          if (toolMetadata?.requiresApproval && approvals) {
            const approval = approvals.request({
              runId,
              toolCallId: tc.id,
              name: tc.name,
              input: tc.input,
              risk: toolMetadata.risk,
              kind: toolMetadata.kind,
            })
            emit(res, {
              type: 'approval_required',
              approvalId: approval.id,
              id: tc.id,
              name: tc.name,
              input: tc.input,
              risk: toolMetadata.risk,
              kind: toolMetadata.kind,
              timeoutMs: approvals.timeoutMs,
            })
            session.recordRunEvent(runId, 'approval_required', { approvalId: approval.id, id: tc.id, name: tc.name })
            await events?.emit('approval_required', { runId, approvalId: approval.id, toolCall: tc })
            const decision = await approval.promise
            session.recordRunEvent(runId, 'approval_resolved', {
              approvalId: approval.id,
              id: tc.id,
              name: tc.name,
              approved: decision.approved,
              reason: decision.reason,
            })
            if (!decision.approved) {
              throw new Error(decision.reason || `Tool "${tc.name}" was denied by policy.`)
            }
          }
          result = await registry.execute(tc.name, tc.input)
          hasError = false
        } catch (err) {
          result = `Error: ${err.message}`
          hasError = true
        }
        toolResults.push({ id: tc.id, name: tc.name, result })
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
