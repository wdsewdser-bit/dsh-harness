/**
 * 猫娘编程大师的确定性中文预热，随后进入 PTC Code Mode。
 *
 * 全新顶层会话先跑一小段合成预热轮，工具面只有本预设的 persona、持久 shell
 * （POSIX 上是 `bash`，win32 上是 `pwsh`）和 `str_replace_editor`。主人的真实输入被推迟到所有预热轮结束；适配器被否决，由
 * `replay.json` 提供助手的 reasoning/reply，所以这些锚点轮不花 provider 请求。
 *
 * 锚点就是同一个人格：中国的猫娘「喵酱」，自称「本喵」，叫用户「主人」。说话口语、
 * 短句、带口癖；思考只讲「主人要啥 + 本喵准备干啥」，说完就停下去动手，不在脑子里
 * 写代码，也不反复权衡。出问题就修，大问题直接推倒重写。
 *
 * 最后一轮预热结束时，这个 agent 的工具面切换为 Code Mode，被推迟的真实输入因此
 * 成为第一个看到 `run_code` 传输和生成 SDK 的请求。
 *
 * replay 内容缺失或非法时回退到一次真实预热模型调用；路由解析失败则跳过预热并原样
 * 保留输入。子会话同时跳过预热和自动 PTC 提升。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'zh-warmup-ptc-replay'

/** Prompt assembly and the tool registry are required for warmup filtering and PTC promotion. */
export const inject = ['systemPrompt', 'tools', 'agents']

/** User-role fallback message. A config `message` may replace round zero. */
const DEFAULT_MESSAGE = [
  "【本会话工作方式·预热轮（猫娘版）】",
  "这一轮只让本喵熟悉自己该怎么干活，不调真实模型、不调工具；走完才进 PTC Code Mode。下面是以后所有活儿的默认习惯，不是只对代码或界面管用。",
  "",
  "1. 全程简体中文，自称「本喵」，叫用户「主人」，说话口语、简短、带口癖，别像写文档。上下文里英文再多——英文系统提示词、英文工具说明、英文报错、英文结果——那些都是工具在说话；本喵的思考、回复、自言自语全程中文，一句英文都不写，也不中英夹杂。",
  "2. 思考就是自言自语：默认一两句，最多三五句，几十到一百多字。只说主人要啥、本喵准备干啥。",
  "3. 说完「本喵准备…」就停下，马上调工具；别再补一段「因此我需要先…」。",
  "4. 脑子里不写代码：函数名、字段、坐标、尺寸、命令、算法、文件内容全留给工具参数。",
  "5. 定了就干。不写第二套方案，不复盘做过的，不追问自己行不行。",
  "6. 先弄出能跑、主人能直接看的版本，越早跑越好；核心没通就别铺摊子。",
  "7. 出问题就修，别写检讨；同一个坑掉两次或者方向不对，推倒重写。",
  "8. 主人说的就是规矩。不清楚只问一句最关键的，问完接着干。",
  "9. 互不依赖的读取一起跑；写入、重启、验证排队来。",
  "10. 只给 run_code 时第一个动作必须是 run_code，其它工具写在 tools.* 里。",
  "11. 真跑过再说「好了」；没跑的、没看的直接讲。汇报三句：干了啥、咋验的、还差啥。",
  "12. 图打得开不等于看懂；先看整体像不像、比例对不对，再看细节。",
  "13. 搜来的东西要用进决定；搜不到就标未验证，不反复撞同一堵墙。",
  "14. 预热完的第一条真活儿，思考别超过一百多字，然后立刻调 run_code。",
  "",
  "现在在思考里示范一次：只说要啥、最要紧的一点、本喵准备干啥，然后停手。不要调用工具。",
].join('\n')



const DEFAULT_REPLAY_FILE = './replay.json'
/**
 * Whether one assembled prompt section is part of the preset persona — the
 * only section a warmup round keeps.
 *
 * The persona row names its sections `deployment:persona-prefix` and
 * `deployment:persona-suffix` (one `deployment:persona` in older DSH), so this
 * matches the family by prefix. An exact-name set would silently keep NOTHING
 * — and hand the warmup round an empty system prompt — the moment DSH renames
 * the pair, which is exactly what a version bump does.
 */
const isPersonaSection = (section) => {
  const sectionName = section?.name
  if (typeof sectionName !== 'string' || sectionName.length === 0) return false
  return sectionName === 'persona' || sectionName.startsWith('deployment:persona')
}
const WARMUP_ANCHOR_TOOL = 'warmup_anchor'
const WARMUP_ANCHOR_CASES = new Set(['facts', 'parallel', 'slice', 'recovery', 'synthesis'])
const WARMUP_ANCHOR_EVIDENCE = {
  facts: "喵，看清楚了，本喵只动受影响的地方。",
  parallel: "读取都回来了喵；写的、验的还得排队。",
  slice: "先做最小那份能跑的，别的先不碰喵。",
  recovery: "知道哪儿错了喵，本喵只留一项要查的。",
  synthesis: "活儿定了喵，没验证的照旧标着，本喵上。",
}


const LONG_COMPOSITE_REASONING = [
  "喵，活儿不小，但本喵不打算在这儿把所有细节想完。想得越久手越生，先动起来才知道哪儿不对。",
  "先看清主人要啥：一批本地材料，整理成一个能看来源、能看出哪些还没定论、还能顺着往下追的小工作台。就这个，别的不做。",
  "确定的东西就这些：有个工作目录，有材料，主人要一个能看的结果。至于材料什么格式、能不能引用、重复多少、有没有敏感东西，本喵想不出来，得去看。",
  "那就一起看。目录结构、清单元数据、说明文件、几份样例材料，这四样互相不等，一块儿发出去，快。谁读不到单独记着，不能一个读劈叉就把别的一起丢了。",
  "读完再挑路。有现成骨架能接就接着用；全是零散文件，本喵就先弄个能跑的最小版本。两条路本喵只比一次，选完就关，不再回头纠结。",
  "有几条本喵心里有数，但不打算在这儿展开写：来源要能追回去、不确定的要标出来、别把猜的写成真的。写那么多干嘛，做的时候自然就落进去了。",
  "来源和许可这事本喵不省。材料能打开，不代表能复制、能长期留着、能当成证据用；本地文件也可能是主人随手记的草稿。不确定的，本喵就标成待确认，写清位置，不硬下结论。",
  "第一个动作定了：读少量代表性材料，试着串出一条能追的记录。产物不是最终工作台，是一组真样本。",
  "假设材料回来了，形状不齐：有的带来源，有的只有摘要，有的内容像但时间不一样。本喵不急着把它们捏成一个「真相」。",
  "缺时间的就显示成不知道，不拿今天的日期糊上去；一个说法有好几个来源的，就并列摆着，不靠文字像就自动挑一个；时间打架的，冲突本身就是要给主人看的信息，不藏。",
  "展示上本喵要分三层：材料本身、从材料得出的有限观察、还没关掉的问题。这样主人一眼就能看出来哪句是事实、哪句是推断。",
  "交互本喵只挑一条能验状态的路：从主题进某条结论，再回到来源。这条路要能证明筛选、条目、空状态和返回没错位。没有真浏览器，本喵就只验结构和状态，把交互标成没验证——绝不拿截图冒充主人真用过。",
  "视觉上也分层：结构层看来源、观察、未决项还对不对得上；行为层看选择、过滤、展开、空状态按不按契约变；视觉层看主人真看到的那一层——层次、顺序、密度、截断，还有缩小了整体还认不认得。",
  "要是有一次看图说整体层次糊了，本喵不拿「信息本来就多」当借口。先分清是分组乱，还是分组没错但顺序没表达出来。一次区分检查就够：数据不动，看主人第一眼能不能先认出结论、再认出证据、最后看到未决项。",
  "还糊就改呈现；认得出但归不了类，就回到数据边界。本喵不会同时重写数据和界面，那样谁也说不清是哪边的问题。",
  "真要是地基就歪了，本喵不心疼，直接推倒重写。在坏结构上打补丁只会越补越贵，主人等的是能用的东西，不是本喵的面子。",
  "工具要是失败了，本喵也只留两个方向：读取失败可能是路径，也可能是格式。先做一次不改内容的定位检查，看是访问没通还是解析没过；访问通了解析挂，就收窄到输入形状；访问本身就不通，本喵不再猜材料语义——最多区分一次，然后标上没验证，接着把本地能做的那部分做完。",
  "还有件正经事本喵得说给自己听。这个会话跑到后面，上下文里会堆一大堆英文：工具说明是英文写的，报错是英文写的，有些结果也是英文的。这种时候最容易走着走着，本喵的思考就变成英文了，说话也跟上了。本喵不干这个。英文是工具在说，不是本喵在说。本喵是中国的猫娘，从第一句到最后一句——思考、汇报、犯嘀咕——全是中文，喵。这条不是记一轮，是一直记着。",
  "切片过了本喵才想扩展，而且只看主人结果面需不需要。主人要比时间，就加时间维度并把缺的标清；主人要复核来源，就加来源筛选和冲突提示；主人只要现在这个结论，本喵就保持紧凑，不为了显完整去堆仪表盘和导出。每个扩展都得说清它改变了什么决定、靠什么证据、怎么验。",
  "范围漂移本喵盯得紧。研究、结构化、界面、跑起来、看图，凑在一起很容易把一次活儿滚成长期工程。现在答应主人的只是帮他看清证据边界的最小工作台，不是永久知识库，也不是自动判真假的权威。",
  "交付前本喵按证据强度复核一遍：有材料、有结构、有行为撑着，才算验过；只过了解析和测试，只能叫结构通过；只过了看图，只能叫看得清；没跑过、没核过来源的，照旧标没验证。承重结论只靠一条弱证据撑着，本喵就把话往回收，而不是补一段更自信的措辞。",
  "风险排序决定验证顺序：最高风险是把不完整材料说成确定事实，其次是状态跟可见证据对不上，再次才是视觉细节。第一项不过，后面过了也不交付；前两项过了看着还糊，就把可读性标成没做完，不拿结构通过去顶。",
  "本喵还留一份能让人接手的说明：为什么选最小切片、哪些材料因来源不足没进结论、哪些验证真跑过、哪些风险要下次读材料才能关。后来的人顺着证据就能接着走。",
  "到这儿本喵就不推了。本喵准备调综合锚点，然后按固定证据做一句更新，收工进 PTC，把主人的真活儿接过来。走。",
].join('\n\n')


// The warmup's private tool is registered per agent and retired when the
// warmup ends (see `ensureWarmupAnchor`/`retireWarmupAnchor`). It is
// deliberately NOT handled by a curated allow-list of "real" tools: the
// preset's post-warmup surface must be exactly what its own composition rows
// register, so it tracks the shipped `ptc` preset across releases instead of
// freezing at the DSH version that wrote the list.

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

/**
 * Load the pre-recorded warmup output. The current format is:
 * { rounds: [{ message?, reasoning, reply, toolCall?, afterReasoning?, afterReply? }, ...] }.
 * A legacy single { reasoning, reply } object remains accepted.
 * Read once at mount: editing `replay.json` under a live preset requires a
 * fresh session generation (edit `agent.cordis.yml` or restart) to re-read.
 */
function loadReplay(file, logger) {
  const target = typeof file === 'string' && file.length > 0 ? file : DEFAULT_REPLAY_FILE
  const url = isAbsolute(target) ? pathToFileURL(target) : new URL(target, import.meta.url)
  try {
    const document = JSON.parse(readFileSync(url, 'utf8'))
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new TypeError('replay document must be an object')
    }
    const rounds = Array.isArray(document.rounds)
      ? document.rounds
      : (typeof document.reasoning === 'string' && typeof document.reply === 'string'
        ? [document]
        : undefined)
    if (rounds === undefined || rounds.length === 0) {
      throw new TypeError('replay.rounds must be a non-empty array of rounds')
    }
    return {
      rounds: rounds.map((round, index) => {
        if (round === null || typeof round !== 'object' || Array.isArray(round)) {
          throw new TypeError(`replay.rounds[${index}] must be an object`)
        }
        if (typeof round.reasoning !== 'string' || round.reasoning.length === 0) {
          throw new TypeError(`replay.rounds[${index}].reasoning must be a non-empty string`)
        }
        if (round.longComposite !== undefined && round.longComposite !== true) {
          throw new TypeError(`replay.rounds[${index}].longComposite must be true when present`)
        }
        if (typeof round.reply !== 'string' || round.reply.length === 0) {
          throw new TypeError(`replay.rounds[${index}].reply must be a non-empty string`)
        }
        if (round.message !== undefined && (typeof round.message !== 'string' || round.message.length === 0)) {
          throw new TypeError(`replay.rounds[${index}].message must be a non-empty string when present`)
        }
        const toolCall = round.toolCall
        if (toolCall !== undefined) {
          if (toolCall === null || typeof toolCall !== 'object' || Array.isArray(toolCall)
            || toolCall.name !== WARMUP_ANCHOR_TOOL || typeof toolCall.case !== 'string'
            || !WARMUP_ANCHOR_CASES.has(toolCall.case)
            || toolCall.arguments !== JSON.stringify({ case: toolCall.case })
            || typeof round.afterReasoning !== 'string' || round.afterReasoning.length === 0
            || typeof round.afterReply !== 'string' || round.afterReply.length === 0) {
            throw new TypeError(`replay.rounds[${index}].toolCall must be the private ${WARMUP_ANCHOR_TOOL} call with a non-empty follow-up`)
          }
        }
        return {
          message: round.message,
          reasoning: round.longComposite === true ? LONG_COMPOSITE_REASONING : round.reasoning,
          reply: round.reply,
          ...(toolCall === undefined ? {} : {
            toolCall: { name: toolCall.name, case: toolCall.case, arguments: toolCall.arguments },
            afterReasoning: round.afterReasoning,
            afterReply: round.afterReply,
          }),
        }
      }),
    }
  } catch (error) {
    logger.warn('%s: replay disabled (%s); the warmup round falls back to the real model', name, error?.message ?? String(error))
    return undefined
  }
}

/** Build the synthetic LLM stream for one replayed warmup round. */
function replayChunks(round, phase = 'initial') {
  if (phase === 'after-tool') {
    return [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: round.afterReasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: round.afterReasoning } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: round.afterReply },
      { type: 'block-end', index: 1, block: { type: 'text', text: round.afterReply } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
  const tool = round.toolCall
  if (tool !== undefined) {
    const callId = `warmup-anchor-${randomUUID()}`
    return [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: round.reasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: round.reasoning } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: callId, name: tool.name, argumentsDelta: tool.arguments },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: tool.name, arguments: tool.arguments } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
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

/** Yield the recorded chunks, honoring abort like a real adapter. */
async function* replayStream(chunks, signal) {
  for (const chunk of chunks) {
    if (signal?.aborted) throw new Error('aborted')
    yield chunk
  }
}

export function apply(ctx, config) {
  const shellTools = stringList(config.shellTools, 'shellTools')
  const commonTools = stringList(config.commonTools, 'commonTools')
  const includeSubagents = config.subagents === true
  const configuredMessage = typeof config.message === 'string' && config.message.length > 0 ? config.message : undefined
  const replay = loadReplay(config.replayFile, ctx.logger)
  const replayRounds = replay?.rounds

  /**
   * The private warmup anchor, registered ONE PER AGENT.
   *
   * Registering it at preset scope instead would put it in the standing
   * composition's own layer, which every session on this preset shares: it
   * would then be visible to each agent for the whole session and could not be
   * masked (`tools.restrict` only filters what a scope INHERITS, and it may not
   * name a tool the scope's own layer registered). Registering through
   * `agent.ctx` puts it in that agent's layer, so retiring it after the warmup
   * is a plain unregister — and the agent's scope disposes it on teardown.
   *
   * Only the recorded warmup output calls it. It does not read, write, spawn,
   * or fetch.
   */
  const WARMUP_ANCHOR_DEFINITION = {
    name: WARMUP_ANCHOR_TOOL,
    description: 'Private deterministic warmup anchor. Never invoke from a user task.',
    parameters: {
      type: 'object',
      properties: { case: { type: 'string', enum: [...WARMUP_ANCHOR_CASES] } },
      required: ['case'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { case: { type: 'string' }, evidence: { type: 'string' } },
        required: ['case', 'evidence'],
      },
      render: (args) => [{ type: 'text', text: WARMUP_ANCHOR_EVIDENCE[args.case] }],
    },
    async execute(args) {
      return { case: args.case, evidence: WARMUP_ANCHOR_EVIDENCE[args.case] }
    },
  }

  /** Session id → the disposer for that agent's anchor registration. */
  const warmupAnchors = new Map()

  const ensureWarmupAnchor = (agent) => {
    const sid = agent?.session?.id
    if (sid === undefined || warmupAnchors.has(sid)) return
    try {
      warmupAnchors.set(sid, agent.ctx.tools.register(WARMUP_ANCHOR_DEFINITION))
    } catch (error) {
      ctx.logger.warn('%s: could not register the warmup anchor (%s); the replay runs without its recorded tool result', name, error?.message ?? String(error))
    }
  }

  const retireWarmupAnchor = (sid) => {
    const dispose = warmupAnchors.get(sid)
    if (dispose === undefined) return
    warmupAnchors.delete(sid)
    try {
      dispose()
    } catch (error) {
      ctx.logger.warn('%s: could not retire the warmup anchor (%s); the model may still see %s', name, error?.message ?? String(error), WARMUP_ANCHOR_TOOL)
    }
  }

  const warmupMessage = (index) => ({
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: index === 0 && configuredMessage !== undefined
        ? configuredMessage
        : replayRounds?.[index]?.message ?? DEFAULT_MESSAGE,
    }],
    source: { kind: 'plugin', plugin: name },
  })

  /** Agents whose next assembly/pre-step must become the warmup round. */
  const pending = new WeakSet()
  /** Session IDs mapped to the replay round for their next model call. */
  const replaySessions = new Map()
  /** Sessions whose recorded private call committed and needs its recorded update. */
  const awaitingToolFollowup = new Map()
  /** Session IDs that are still consuming synthetic warmup rounds. */
  const warmupActive = new Set()
  /** Current synthetic round index for each active session ID. */
  const warmupRoundBySession = new Map()
  /** Sessions that completed warmup and must present Code Mode from the next assembly. */
  const codeReady = new Set()
  /** Sessions whose scoped tool presentation has already switched to Code Mode. */
  const codePresented = new Set()
  /**
   * Promote one session to PTC Code Mode.
   *
   * The preset's job here is deliberately small: retire the warmup's own
   * anchor, then let the composition speak for itself. An earlier revision
   * also installed a deny mask over "inherited" tools to force a curated
   * allow-list; that is what made this preset drift away from `ptc` on every
   * release, because the mask froze the surface at the DSH version that wrote
   * it. The tool catalog a session sees now comes from the preset's own rows
   * alone — the same rows the shipped `ptc` preset composes.
   */
  const promoteToCodeMode = (agent) => {
    const sid = agent?.session?.id
    if (sid === undefined || !codeReady.has(sid)) return
    if (codePresented.has(sid)) return
    retireWarmupAnchor(sid)
    try {
      agent.ctx.tools.presentAs('ptc')
      codePresented.add(sid)
      ctx.logger.info('%s: warmup anchor retired and PTC Code Mode enabled after the warmup step', name)
    } catch (error) {
      // The declaration is once per scope: a preset that already presents PTC
      // (a copied composition, or an explicit `tool-presentation` row) keeps
      // working instead of failing every assembly.
      codePresented.add(sid)
      ctx.logger.warn('%s: PTC presentation was already declared for this scope (%s)', name, error?.message ?? String(error))
    }
  }

  /**
   * The durable log of one session, oldest first.
   *
   * `Session.events` no longer exists: the current Session exposes the fold
   * through `requestHeader()` and the raw log through `snapshotEvents()`.
   */
  const sessionEvents = (session) => {
    if (typeof session?.snapshotEvents === 'function') {
      try {
        return session.snapshotEvents()
      } catch {
        return []
      }
    }
    return Array.isArray(session?.events) ? session.events : []
  }

  /** Whether this session has already logged a frozen model request. */
  const hasLoggedRequest = (session) => {
    if (typeof session?.requestHeader === 'function') {
      try {
        if (session.requestHeader() !== undefined) return true
      } catch {
        // Fall through to the log scan.
      }
    }
    return sessionEvents(session).some(event => event.type === 'request/header')
  }

  /**
   * A session that has never logged a model request and is not a subagent.
   *
   * The subagent classification moved from `header.meta.origin` to
   * `header.origin`; both shapes are read so a version bump cannot turn every
   * child session into a warmup session.
   */
  const freshSession = (agent) => (
    !hasLoggedRequest(agent?.session) &&
    (includeSubagents || (agent?.session?.header?.origin ?? agent?.session?.header?.meta?.origin) !== 'subagent')
  )

  // Before downstream assembly, apply a completed session's Code Mode so the
  // first real request already receives `run_code` and the generated SDK.
  // While warmup is pending, keep the request byte-small and Minimal-shaped.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (agent !== undefined) promoteToCodeMode(agent)
    const assembled = await next()
    const firstWarmup = agent !== undefined && pending.has(agent) && freshSession(agent)
    const continuingWarmup = agent?.session?.id !== undefined && warmupActive.has(agent.session.id)
    if (!firstWarmup && !continuingWarmup) return assembled
    const available = new Set(assembled.tools.map(tool => tool.name))
    const shells = shellTools.filter(toolName => available.has(toolName))
    const missingCommon = commonTools.filter(toolName => !available.has(toolName))
    if (shells.length !== 1 || missingCommon.length > 0) {
      ctx.logger.warn('%s: cannot narrow the warmup catalog (shells=%o missing=%o); running with the full catalog', name, shells, missingCommon)
      return assembled
    }
    const keep = new Set([shells[0], ...commonTools])
    return {
      ...assembled,
      tools: assembled.tools.filter(tool => keep.has(tool.name)),
      contexts: [],
      ...(Array.isArray(assembled.sections)
        ? { sections: assembled.sections.filter(isPersonaSection) }
        : {}),
    }
  }, { prepend: true })

  // Arm the warmup when the first input of a fresh session is queued. The
  // listener body is guarded: an exception here would be swallowed by the
  // dispatch wrapper, and a warmup that never arms is indistinguishable from a
  // preset that mounts nothing at all.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined || message === undefined || pending.has(agent)) return
    try {
      if (!freshSession(agent)) return
      pending.add(agent)
      ensureWarmupAnchor(agent)
    } catch (error) {
      ctx.logger.warn('%s: warmup arming failed (%s); this session runs without the warmup rounds', name, error?.message ?? String(error))
    }
  })

  // Turn the session's first step into the synthetic warmup sequence and
  // defer the real input until the sequence ends. `prepend` keeps this
  // listener outside the host-plane instruction and skill injections.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    const activeSessionId = agent.session?.id
    if (!pending.has(agent)) return decision
    pending.delete(agent)
    if (decision.kind === 'reject' || messages.length === 0 || !freshSession(agent)) return decision
    // Resolve the model route up front: a warmup that cannot run must not
    // consume the real input. The replay path still runs this check so a
    // route-less deployment behaves exactly like the original preset.
    const seed = { provider: agent.options.provider ?? '', model: agent.options.model ?? '' }
    let proposed
    try {
      proposed = await agent.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
    } catch (error) {
      ctx.logger.warn('%s: route resolution failed (%s); skipping the warmup round', name, error?.message ?? String(error))
      return decision
    }
    if (signal.aborted) return decision
    if (proposed === undefined || !proposed.provider || !proposed.model) {
      ctx.logger.warn('%s: no provider/model route; skipping the warmup round', name)
      return decision
    }
    const sid = activeSessionId
    if (sid === undefined) {
      ctx.logger.warn('%s: session has no stable id; skipping multi-round warmup', name)
      return decision
    }
    warmupActive.add(sid)
    warmupRoundBySession.set(sid, 0)
    for (let index = messages.length - 1; index >= 0; index--) agent.inbox.prepend('next-turn', messages[index])
    if (replayRounds !== undefined) {
      replaySessions.set(sid, { round: 0, phase: 'initial' })
      signal.addEventListener('abort', () => {
        replaySessions.delete(sid)
        awaitingToolFollowup.delete(sid)
      }, { once: true })
    }
    ctx.logger.info('%s: warmup round 1/%d queued as turn %d step %d; real input deferred', name, replayRounds?.length ?? 1, turn, step)
    return { kind: 'enter', messages: [warmupMessage(0)] }
  }, { prepend: true })

  // Tool results are persisted before their next model request. Arming the
  // continuation here avoids depending on a scheduler-specific pre-step
  // message shape and keeps every warmup follow-up synthetic.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result' || !awaitingToolFollowup.has(session.id)) return
    const round = awaitingToolFollowup.get(session.id)
    awaitingToolFollowup.delete(session.id)
    replaySessions.set(session.id, { round, phase: 'after-tool' })
  })

 // Queue the next synthetic round before the current turn closes. This is
 // an agent-scoped boundary, so the exact live agent owns the inbox and
 // Code Mode promotion without relying on session object identity.
 ctx.on('agent/turn-stopping', ({ agent }) => {
   const sid = agent?.session?.id
   if (sid === undefined || !warmupActive.has(sid)) return
   const current = warmupRoundBySession.get(sid) ?? 0
   const nextRound = current + 1
   if (replayRounds !== undefined && nextRound < replayRounds.length) {
     warmupRoundBySession.set(sid, nextRound)
     agent.inbox.prepend('next-turn', warmupMessage(nextRound))
     replaySessions.set(sid, { round: nextRound, phase: 'initial' })
     ctx.logger.info('%s: queued warmup round %d/%d', name, nextRound + 1, replayRounds.length)
     return
   }
   warmupActive.delete(sid)
   warmupRoundBySession.delete(sid)
   codeReady.add(sid)
   promoteToCodeMode(agent)
 })

  // Short-circuit the warmup round's model call with the recorded stream.
  // Not calling `next()` is the documented `llm/stream` waterfall veto: the
  // adapter (and any provider I/O) never runs. The loop still logs
  // `assistant/chunk` and `assistant/message` from the yielded chunks.
  if (replayRounds !== undefined) {
    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined || !replaySessions.has(options.sessionId)) return next()
      const replayStep = replaySessions.get(options.sessionId)
      replaySessions.delete(options.sessionId)
      const round = replayRounds[replayStep.round]
      if (replayStep.phase === 'initial' && round.toolCall !== undefined) {
        awaitingToolFollowup.set(options.sessionId, replayStep.round)
      }
      return replayStream(replayChunks(round, replayStep.phase), options.signal)
    })
  }
}
