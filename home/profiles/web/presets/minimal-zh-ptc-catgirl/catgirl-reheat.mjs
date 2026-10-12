/**
 * 压缩（compaction）之后补一轮「重新预热」。
 *
 * 为什么需要它：
 * 这个预设的 few-shot 锚定靠开头那 10 轮中文长思维链。一次 compaction 会把
 * 之前整个对话面折成一份 <compacted-summary>，那 10 轮示范就没了——之后的
 * 第一次请求是「第二次第一次请求」，模型面对的是英文摘要加一堆英文工具结果，
 * 长会话里最容易在这个点彻底跑偏。catgirl-persona-anchor.mjs 那条短锚定会被
 * RuntimeContextProjection 自动重投影，但它只有几句话，不够当 few-shot。
 *
 * 所以：每次 `compaction/end` 之后，等下一个 turn 开头，先把主人的真实输入
 * 按原顺序放回 next-turn 队列，然后跑 N 轮**合成**重热轮（默认 2 轮）：
 * 消息文本来自 catgirl-reheat.json，assistant 侧由 llm/stream 瀑布直接回放，
 * 不产生 provider 请求。走完最后一个回合才轮到主人的真活儿——那时历史尾部就是
 * 刚落地的一整段中文长 reasoning。
 *
 * 与其他部件的边界：
 *   - 预热（zh-warmup-ptc-replay）没跑完不重热；判定走 catgirl-mode.mjs 的
 *     持久计数闸门，resume 后一致。
 *   - 不改工具面：重热轮照样看到 PTC 的 run_code + SDK，和真实工作一致（预热那套
 *     「收窄工具面」只属于第一次冷启动）。
 *   - 子代理默认跳过；每个会话有次数上限（maxPerSession）防止病态循环。
 *   - llm/stream 只在「请求里确实带着本插件那条重热消息」时才否决，避免误吞
 *     同一个会话里别的模型调用（例如 compaction 自己的摘要请求）。
 */

import { randomUUID } from 'node:crypto'
import { createWarmupGate, isSubagentSession, readJson, warmupRoundCount } from './catgirl-mode.mjs'

export const name = 'catgirl-reheat'

/** Deliberately no inject list：apply 期只读本地 JSON，事件期才碰 agent。 */
export const inject = []

/** 默认重热文案文件（和预设同目录）。 */
const DEFAULT_REHEAT_FILE = './catgirl-reheat.json'
/** 默认预热 replay 文件，用来推算预热闸门阈值。 */
const DEFAULT_WARMUP_FILE = './replay.json'
/** 重热消息必须带这段文字，llm/stream 才认它是重热请求。 */
const REHEAT_MARKER = '压缩后重新预热'
/** 文件读坏时最多重热几条？默认 2 条。 */
const DEFAULT_ROUNDS = 2

/**
 * 读并校验重热文案。格式：
 * { rounds: [{ message, reasoning, reply }, ...] }
 * @returns 轮数组；文件缺失或非法时 undefined（插件变哑巴，但会话照跑）。
 */
function loadRounds(file, ctx) {
  const document = readJson(file, import.meta.url)
  const rounds = document?.rounds
  if (!Array.isArray(rounds) || rounds.length === 0) {
    ctx.logger?.warn?.(`${name}: no usable reheat rounds at ${file}; post-compaction reheat disabled`)
    return undefined
  }
  const parsed = []
  for (const [index, round] of rounds.entries()) {
    if (round === null || typeof round !== 'object' || Array.isArray(round)
      || typeof round.message !== 'string' || round.message.length === 0
      || typeof round.reasoning !== 'string' || round.reasoning.length === 0
      || typeof round.reply !== 'string' || round.reply.length === 0) {
      ctx.logger?.warn?.(`${name}: reheat round ${index} is invalid; post-compaction reheat disabled`)
      return undefined
    }
    parsed.push({ message: round.message, reasoning: round.reasoning, reply: round.reply })
  }
  return parsed
}

/** 非负整数配置读取。 */
function nonNegativeInt(value, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${name}: expected a non-negative number; got ${JSON.stringify(value)}`)
  }
  return Math.trunc(parsed)
}

/** 一条合成重热轮的 chunk 流：reasoning + 文本，无工具调用（回完即收工）。 */
function roundChunks(round) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: round.reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: round.reasoning } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: round.reply },
    { type: 'block-end', index: 1, block: { type: 'text', text: round.reply } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 按录制顺序吐 chunk，abort 时像真适配器一样抛。 */
async function* replayStream(chunks, signal) {
  for (const chunk of chunks) {
    if (signal?.aborted) throw new Error('aborted')
    yield chunk
  }
}

/** 请求里是否带着本插件的重热消息（防止误否决别的模型调用）。 */
function carriesReheat(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(REHEAT_MARKER)) return true
    }
  }
  return false
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const includeSubagents = config.subagents === true
  const maxPerSession = nonNegativeInt(config.maxPerSession, 4)
  const reheatFile = typeof config.reheatFile === 'string' && config.reheatFile.length > 0
    ? config.reheatFile
    : DEFAULT_REHEAT_FILE
  const warmupFile = typeof config.replayFile === 'string' && config.replayFile.length > 0
    ? config.replayFile
    : DEFAULT_WARMUP_FILE
  const rounds = enabled ? loadRounds(reheatFile, ctx) : undefined
  if (rounds === undefined) return

  const warmupRounds = config.warmupRounds === undefined || config.warmupRounds === 'auto'
    ? warmupRoundCount(warmupFile, import.meta.url, 10)
    : nonNegativeInt(config.warmupRounds, 0)
  const gate = createWarmupGate(warmupRounds)

  /** 压缩过、等着在下一个 turn 开头重热的会话。 */
  const pending = new Set()
  /** sessionId -> 正在回放的轮号。 */
  const active = new Map()
  /** sessionId -> 下一次 llm/stream 该回放的轮号。 */
  const armed = new Map()
  /** sessionId -> 已重热次数（上限用）。 */
  const reheated = new Map()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 忽略日志失败。
    }
  }

  /** 第 index 轮的重热 user 消息（带标记，llm/stream 靠它认领）。 */
  const reheatMessage = (sessionId, index) => ({
    id: `catgirl-reheat-${sessionId}-${index}-${randomUUID()}`,
    role: 'user',
    content: [{
      type: 'text',
      text: `【${REHEAT_MARKER}·${index + 1}/${rounds.length}】\n${rounds[index].message}`,
    }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: 'catgirl post-compaction reheat',
    },
  })

  ctx.on('session/event', (session, event) => {
    try {
      gate.observe(session, event)
      if (event?.type !== 'compaction/end') return
      const sid = session?.id
      if (sid === undefined || sid === null) return
      if (active.has(sid) || pending.has(sid)) return
      if ((reheated.get(sid) ?? 0) >= maxPerSession) return
      pending.add(sid)
    } catch (error) {
      warnOnce(`${name}: compaction watch failed: ${String((error && error.message) || error)}`)
    }
  })

  // 重热轮放在下一个 turn 的开头：把主人真实输入原顺序放回队列，先跑合成轮。
  // 注册顺序在锚定插件之前（本行在 composition 里更靠前），但两边互不依赖：
  // 锚定插件看到末尾是本插件的消息就自觉让位。
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next()
    try {
      if (decision === undefined || decision.kind !== 'enter') return decision
      const session = agent?.session
      const sid = session?.id
      if (sid === undefined || sid === null || !pending.has(sid)) return decision
      if (step !== 1) return decision
      if (!Array.isArray(messages) || messages.length === 0) return decision
      if (!includeSubagents && isSubagentSession(session)) {
        pending.delete(sid)
        return decision
      }
      if (!gate.isDone(session)) return decision

      for (let index = messages.length - 1; index >= 0; index -= 1) {
        agent.inbox.prepend('next-turn', messages[index])
      }
      pending.delete(sid)
      reheated.set(sid, (reheated.get(sid) ?? 0) + 1)
      active.set(sid, 0)
      armed.set(sid, 0)
      ctx.logger?.info?.(`${name}: reheat 1/${rounds.length} after compaction; real input deferred`)
      return { kind: 'enter', messages: [reheatMessage(sid, 0)] }
    } catch (error) {
      warnOnce(`${name}: reheat injection failed, continuing normally: ${String((error && error.message) || error)}`)
      return decision
    }
  })

  // 当前重热轮没有工具调用，turn 到此结束；在这里排下一轮，或者收工。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const sid = agent?.session?.id
      if (sid === undefined || sid === null || !active.has(sid)) return
      const nextRound = active.get(sid) + 1
      if (nextRound < rounds.length) {
        active.set(sid, nextRound)
        armed.set(sid, nextRound)
        agent.inbox.prepend('next-turn', reheatMessage(sid, nextRound))
        ctx.logger?.info?.(`${name}: reheat ${nextRound + 1}/${rounds.length} queued`)
        return
      }
      active.delete(sid)
      armed.delete(sid)
    } catch (error) {
      warnOnce(`${name}: reheat queueing failed: ${String((error && error.message) || error)}`)
    }
  })

  // 短路重热轮的模型调用，回放录制文本（llm/stream 不调 next() 就是否决）。
  ctx.on('llm/stream', (options, next) => {
    const sid = options?.sessionId
    if (sid === undefined || sid === null || !armed.has(sid)) return next()
    if (!carriesReheat(options?.messages)) return next()
    const round = armed.get(sid)
    armed.delete(sid)
    const content = rounds[round]
    if (content === undefined) return next()
    return replayStream(roundChunks(content), options?.signal)
  })
}
