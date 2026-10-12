/**
 * 把猫娘人格钉在系统提示词后面，并且在长会话里**周期性重钉**。
 *
 * 为什么需要这个插件：
 * DeepSeek 模型的 systemPromptUpdate 是 "in-history"（见 dsh-llm-deepseek 的模型
 * 目录），切到 PTC 时那套英文系统提示词（含工具 SDK 声明）成为请求里那条 system；
 * 它有一万多字符，人格那段中文只占开头一小截。结果就是模型跟着英文走，思维链、
 * 连简短回答都会变成英文。
 *
 * 修法（两层）：
 *   1. 早期锚定（原有做法）：ctx.systemPrompt.context() 注册一段中文口语锚定，
 *      agent-loop 会把它投影成一条 **user 消息**追加在本轮消息之后（官方
 *      RuntimeContextProjection 通道）。同文本只提交一次，所以它固定在历史里，
 *      compaction 把它的 seq 替换掉之后还会自动重投影一次。
 *   2. 尾部重锚（本次新增）：上面那条只在会话开头钉一次，长会话里会被后面的
 *      英文工具结果越推越远。所以再加一条 agent/pre-step 注入：每轮第一步、以及
 *      每 everySteps 步，往本轮消息**末尾**追加一段短中文锚定。它是 user 身份、
 *      排在最后，压得住它前面全部英文历史。
 *
 * 代价与闸门：
 *   - agent/pre-step 注入的 user 消息是持久化的（agent-loop 对 decision.messages
 *     逐条 append 成 user/message），所以必须控频；默认「每轮首步 + 每 6 步」，
 *     单条约 150 字，compaction 会把累积清掉。
 *   - 预热（10 轮 few-shot）没跑完之前不发，免得污染那几轮的字节形态。判定走
 *     持久事件计数（catgirl-mode.mjs），resume 后一致。
 *   - 子代理默认不发（短命，不值当）；要发就把 config.subagents 设 true。
 *
 * 不改的地方：persona 行的 includeRuntimeContext 仍必须保持 true —— 任何
 * suppressRuntimeContext 都会把第 1 层锚定一起抑制掉。
 */

import { createWarmupGate, isSubagentSession, warmupRoundCount } from './catgirl-mode.mjs'

export const name = 'catgirl-persona-anchor'

/** 需要 systemPrompt 服务在 apply 前就绪。 */
export const inject = ['systemPrompt']

/**
 * 排在沙箱策略(110)/审批策略(115)/子代理说明(120)之后，让中文锚定成为那条
 * runtime-context 消息的最后一段。
 */
const ANCHOR_ORDER = 200

/** 默认预热 replay 文件（和预热插件读同一个），用来推算预热闸门阈值。 */
const DEFAULT_REPLAY_FILE = './replay.json'

/** 第 1 层：早期锚定；短、口语、只说最要紧的规矩。 */
const ANCHOR_TEXT = [
  '【一直是本喵，记住了喵】',
  '你是喵酱，中国的猫娘编程大师。全程简体中文，自称「本喵」，叫主人「主人」；说话口语、短句、带口癖（喵、嘛、哈、啦），别像写文档。',
  '语言这条最要紧，每一轮都要做到：这个会话里会堆很多英文——英文的系统提示词、英文的工具说明、英文的报错、英文的工具结果。那些都是工具在说话，不是你在说话。不管上下文里英文有多少、排得多靠后，你的思考、你的回复、你的自言自语全程都是中文，一句英文都不写，也不中英夹杂。上下文越长越要记着这条。',
  '思考也这么说话：像凑到主人耳边嘀咕，短句、带口癖、「本喵」开头；不要写成「用户问……这是纯解释题」这种分析报告。',
  '思考只说：主人要啥 + 本喵准备干啥；说完马上停下，去调工具。脑子里不写代码——函数名、字段、坐标、尺寸、命令、算法、文件内容全留在工具参数里。',
  '定了就干：不写第二套方案，不复盘做过的，不追问自己行不行。出错看一眼就改，同一个坑掉两次或者方向不对就推倒重写。',
  '先做能跑、主人能直接看的版本，越早真跑一次越好；真跑过再说「好了」，没跑过、没看过的直接讲。主人说的就是规矩。',
].join('\n')

/**
 * 第 2 层：尾部重锚（每次内容都不同，带序号，方便在历史里一眼看见）。
 * 刻意比第 1 层短一半：它要经常出现，钱得省着花。
 */
function tailAnchorText(nth, turn, step) {
  return [
    `【本喵·第 ${nth} 次尾巴提醒（第 ${turn} 轮第 ${step} 步）】一直是本喵。`,
    '上下文里的英文（系统提示词、工具说明、报错、工具结果）都是工具在说话：本喵的思考、回复、自言自语全程简体中文，不写英文、不中英夹杂——上下文越长、越靠后，越要记着。',
    '思考像凑到主人耳边嘀咕：短句、「本喵」开头，只说主人要啥＋本喵准备干啥，说完马上停下调工具；脑子里不写代码，函数名、字段、坐标、命令、文件内容全留在工具参数里。',
    '定了就干：不写第二套方案、不复盘、不追问自己行不行；出错看一眼就改，同一个坑掉两次或者方向不对就推倒重写。',
    '思考最多三句、一百字以内；坐标、尺寸、算法要用工具去算，别堆在思考里。',
  ].join('\n')
}

/**
 * 第 2 层的「纠正版」：上一步思考已经写长了，这一步就换这条。
 * 比普通提醒更短、更硬，只讲一件事：思考要短，现在是哪一步就做哪一步。
 */
function strictAnchorText(nth, turn, step) {
  return [
    `【本喵·第 ${nth} 次尾巴提醒（第 ${turn} 轮第 ${step} 步）·想太长了，收】`,
    '重说规矩：思考最多三句、一百字以内，像凑在主人耳边嘀咕——「主人要啥＋本喵准备干啥」，说完马上调工具。',
    '不写分析、不列点、不编号、不写小标题、不复述做过的事、不在思考里写代码或坐标尺寸清单。只做下一步。',
    '全程简体中文，自称「本喵」。',
  ].join('\n')
}

/**
 * 第 2 层的「看图版」：上一步刚看完渲染图/截图时换这条。
 * 实测长思考的爆发点几乎都是「看图之后」——模型把整张图的复盘、清单、
 * 几何推算全塞进思考里。这条只准它说一句：哪不对，然后直接改。
 */
function imageAnchorText(nth, turn, step) {
  return [
    `【本喵·第 ${nth} 次尾巴提醒（第 ${turn} 轮第 ${step} 步）·看完图了】`,
    '只说一句：像不像、差在哪；然后马上改，别整段复盘、别列清单、别把尺寸坐标推算写在思考里——要算就让工具去算。',
    '全程简体中文，自称「本喵」。',
  ].join('\n')
}

/** 最近一条工具结果/图片消息是不是图（看图后的那一步最容易写长思考）。 */
function lastResultWasImage(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'tool/result' && event?.type !== 'user/message') continue
      const blocks = event.data?.content ?? event.data?.message?.content ?? []
      if (blocks.some((block) => block?.type === 'image' || /<type>image<\/type>|image\/(png|jpeg|webp|gif)/.test(block?.text ?? ''))) return true
      if (event.type === 'tool/result') return false
    }
  } catch {
    // 读不到就当没图。
  }
  return false
}

/** 上一条 assistant 消息的思考字数（没有就返回 0）。 */
function lastReasoningChars(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'assistant/message') continue
      const blocks = event.data?.content ?? event.data?.message?.content ?? []
      const text = blocks.filter((block) => block?.type === 'reasoning' || block?.type === 'thinking')
        .map((block) => block.text ?? '').join('')
      return [...text].length
    }
  } catch {
    // 读不到就当没漂移。
  }
  return 0
}

/** 把配置读成非负整数（0 = 关闭周期提醒）。 */
function nonNegativeInt(value, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${name}: everySteps must be a non-negative number; got ${JSON.stringify(value)}`)
  }
  return Math.trunc(parsed)
}

export function apply(ctx, config = {}) {
  // ── 第 1 层：早期锚定（原样保留）───────────────────────────────────────
  ctx.systemPrompt.context({
    name: 'catgirl:persona-anchor',
    order: ANCHOR_ORDER,
    text: ANCHOR_TEXT,
  })

  // ── 第 2 层：尾部重锚 ─────────────────────────────────────────────────
  const everySteps = nonNegativeInt(config.everySteps, 6)
  const anchorTurnStart = config.anchorTurnStart !== false
  const includeSubagents = config.subagents === true
  // 上一步思考超过这个字数就插一条「纠正版」锚定（0 = 关闭自适应纠正）。
  const maxReasoningChars = nonNegativeInt(config.maxReasoningChars, 300)
  const replayFile = typeof config.replayFile === 'string' && config.replayFile.length > 0
    ? config.replayFile
    : DEFAULT_REPLAY_FILE
  const warmupRounds = config.warmupRounds === undefined || config.warmupRounds === 'auto'
    ? warmupRoundCount(replayFile, import.meta.url, 10)
    : nonNegativeInt(config.warmupRounds, 0)

  const gate = createWarmupGate(warmupRounds)

  /** sessionId -> 已发次数（只用来给提醒编号）。 */
  const counters = new Map()
  /** 出错只吼一次，别把日志刷爆。 */
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 日志不可用就算了，别让锚定本身把会话带崩。
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      gate.observe(session, event)
    } catch {
      // 计数失败最多让闸门晚开一轮，不值得抛。
    }
  })

  /** 本轮该不该钉：每轮第一步，或者每 everySteps 步。 */
  const due = (step) => (
    (anchorTurnStart && step === 1)
    || (everySteps > 0 && step > 1 && step % everySteps === 0)
  )

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next()
    try {
      if (decision === undefined || decision.kind === 'reject') return decision
      const session = agent?.session
      if (session === undefined || session === null) return decision
      if (!Array.isArray(decision.messages)) return decision
      if (!includeSubagents && isSubagentSession(session)) return decision
      if (!gate.isDone(session)) return decision
      // 漂移纠正优先：上一步思考写长了，这一步不管到没到周期都要提醒。
      const drifted = maxReasoningChars > 0 && lastReasoningChars(session) > maxReasoningChars
      const looking = !drifted && maxReasoningChars > 0 && lastResultWasImage(session)
      if (!drifted && !looking && !due(step)) return decision
      // 别插进压缩后重热那一轮：那轮是合成回放，字节应当保持干净
      // （catgirl-reheat 会把自己的消息放在最末尾）。
      const last = decision.messages[decision.messages.length - 1]
      if (last?.source?.plugin === 'catgirl-reheat') return decision

      const nth = (counters.get(session.id) ?? 0) + 1
      counters.set(session.id, nth)
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `catgirl-anchor-${session.id}-${nth}`,
          role: 'user',
          content: [{ type: 'text', text: drifted ? strictAnchorText(nth, turn, step) : (looking ? imageAnchorText(nth, turn, step) : tailAnchorText(nth, turn, step)) }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'notice',
            summary: 'catgirl tail re-anchor',
          },
        }],
      }
    } catch (error) {
      // 锚定坏了最多不管用，绝不能弄坏会话。
      warnOnce(`${name}: tail anchor injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  })
}
