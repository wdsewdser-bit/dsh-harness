/**
 * Add a short, second-precision timestamp to model-visible conversation events.
 *
 * The timestamp is appended at the end of a message or tool result so it does
 * not disturb the stable prompt prefix. New events are stamped once; existing
 * timestamps are preserved and never rewritten.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'team-message-time'
export const inject = []

const INSTALL_KEY = Symbol.for('dsh.team-message-time.installed.v3')
const SKIP_RESPONSE = Symbol.for('dsh.team-message-time.skip-response')
const MAX_INBOX_TIMES = 4096
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const TIMESTAMP_AT_END = /(?:^|\r?\n)\[time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00\]\s*$/
const HIDDEN_TIMESTAMP_AT_END = /(?:^|\r?\n)\[\/\/\]: # "time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00"\s*$/

const DEFAULTS = Object.freeze({
  enabled: true,
  stampMessages: true,
  stampToolResults: true,
  stampResponses: false,
  timeZone: DEFAULT_TIME_ZONE,
})

function dateOf(value) {
  if (value instanceof Date) return value
  const date = value === undefined ? new Date() : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function timeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

/**
 * Format the canonical timestamp used by every Team-visible injection.
 * The fixed +08:00 suffix is correct for Asia/Shanghai and keeps the string
 * compact and stable for both humans and models.
 */
export function timestampText(now = Date.now(), config = {}) {
  const date = dateOf(now)
  const zone = typeof config.timeZone === 'string' && config.timeZone.length > 0
    ? config.timeZone
    : DEFAULT_TIME_ZONE
  const parts = timeParts(date, zone)
  return '[time: ' + parts.year + '-' + parts.month + '-' + parts.day
    + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' +08:00]'
}

export function hasTimestamp(text) {
  return typeof text === 'string'
    && (TIMESTAMP_AT_END.test(text) || HIDDEN_TIMESTAMP_AT_END.test(text))
}

export function hiddenTimestampText(now = Date.now(), config = {}) {
  return '[//]: # "' + timestampText(now, config).slice(1, -1) + '"'
}

/**
 * Build a source-attributed context message. DSH renders this as an injected
 * context row instead of appending text to the assistant/reasoning stream.
 */
function timestampContextMessage(now, config) {
  const text = timestampText(now, config)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: name,
      form: 'snapshot',
      sections: [{ name, text }],
    },
  })
}

function stampWith(text, suffix) {
  if (typeof text !== 'string') return text
  if (hasTimestamp(text)) return text
  return text.length === 0 ? suffix : text + '\n' + suffix
}

export function stampText(text, now = Date.now(), config = {}) {
  return stampWith(text, timestampText(now, config))
}

export function stampHiddenText(text, now = Date.now(), config = {}) {
  return stampWith(text, hiddenTimestampText(now, config))
}

function stampContentWith(content, suffix) {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: 'text', text: suffix }]
  }
  const next = content.slice()
  let lastTextIndex = -1
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.type === 'text') {
      lastTextIndex = index
      break
    }
  }
  if (lastTextIndex >= 0) {
    const block = next[lastTextIndex]
    const text = typeof block.text === 'string' ? block.text : ''
    if (hasTimestamp(text)) return content
    next[lastTextIndex] = { ...block, text: stampWith(text, suffix) }
    return next
  }
  next.push({ type: 'text', text: suffix })
  return next
}

export function stampContent(content, now = Date.now(), config = {}) {
  return stampContentWith(content, timestampText(now, config))
}

export function stampHiddenContent(content, now = Date.now(), config = {}) {
  return stampContentWith(content, hiddenTimestampText(now, config))
}

export function stampUserMessage(message, now = Date.now(), config = {}) {
  if (!message || message.role !== 'user') return message
  // Human prompts already render as bubbles; a visible clock suffix would leak
  // into the UI and alter what the user appears to have sent.
  if (message.source?.kind === 'user') return message
  const content = stampContent(message.content, now, config)
  if (content === message.content) return message
  return { ...message, content }
}

function stampAdditionalContexts(contexts, now, config) {
  if (!Array.isArray(contexts) || contexts.length === 0) return contexts
  return contexts.map((message) => stampUserMessage(message, now, config))
}

export function stampPostToolDecision(decision, now = Date.now(), config = {}, resultContent) {
  if (!decision || (decision.kind !== 'accept' && decision.kind !== 'block')) return decision
  return {
    ...decision,
    additionalContexts: [
      ...(Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []),
      timestampContextMessage(now, config),
    ],
  }
}

function shouldStampResponse(options) {
  if (options?.[SKIP_RESPONSE] === true) return false
  if (options?.purpose === 'session-title') return false
  return true
}

function successfulFinish(reason) {
  return reason?.kind === 'stop' || reason?.kind === 'tool-calls' || reason?.kind === 'max-tokens'
}

/**
 * Append one text block before the terminal finish chunk. The provider stream
 * remains untouched; only the model-visible assembled response gains the
 * timestamp block.
 */
export async function* stampAssistantStream(stream, now = Date.now(), config = {}) {
  let maxIndex = -1
  let stamped = false
  for await (const chunk of stream) {
    if (chunk?.type === 'finish') {
      if (!stamped && successfulFinish(chunk.reason)) {
        const index = maxIndex + 1
        const text = hiddenTimestampText(now, config)
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text }
        yield { type: 'block-end', index, block: { type: 'text', text } }
        stamped = true
      }
      yield chunk
      continue
    }
    if (Number.isInteger(chunk?.index)) maxIndex = Math.max(maxIndex, chunk.index)
    yield chunk
  }
}

/**
 * Install the hooks once per live context. Returns a disposer suitable for HMR.
 */
export function installMessageTime(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (cfg.enabled !== true) return () => {}
  const prior = ctx[INSTALL_KEY]
  if (typeof prior === 'function') {
    try { prior() } catch {}
  }
  const disposers = []
  const options = { global: true, prepend: true }
  const inboxTimes = new Map()

  const rememberInboxTime = (message) => {
    if (!message || message.id === undefined || message.id === null) return
    const id = String(message.id)
    const explicit = Number(message.createdAt ?? message.timestamp)
    inboxTimes.set(id, Number.isFinite(explicit) && explicit > 0 ? explicit : Date.now())
    while (inboxTimes.size > MAX_INBOX_TIMES) {
      const oldest = inboxTimes.keys().next().value
      if (oldest === undefined) break
      inboxTimes.delete(oldest)
    }
  }

  try {
    if (cfg.stampMessages !== false) {
      disposers.push(ctx.on('agent/inbox/inserted', ({ message }) => {
        rememberInboxTime(message)
      }, { global: true }))
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = typeof next === 'function' ? await next() : payload
        if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        return {
          ...decision,
          messages: [
            ...decision.messages,
            timestampContextMessage(Date.now(), cfg),
          ],
        }
      }, options))
    }

    if (cfg.stampToolResults !== false) {
      disposers.push(ctx.on('tools/post-execute', async (_exec, result, next) => {
        const decision = typeof next === 'function' ? await next() : undefined
        return stampPostToolDecision(decision, new Date(), cfg, result?.content)
      }, options))
    }

    // Assistant/reasoning streams are intentionally never mutated. Appending
    // text there makes DSH render reasoning blocks as ordinary visible chat.
  } catch (error) {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
    delete ctx[INSTALL_KEY]
    throw error
  }

  console.log('[team-message-time] HMR time-v4-silent-context loaded 2026-09-27')
  const dispose = () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
    if (ctx[INSTALL_KEY] === dispose) delete ctx[INSTALL_KEY]
  }
  ctx[INSTALL_KEY] = dispose
  return dispose
}

export function apply(ctx, config = {}) {
  return installMessageTime(ctx, config)
}
