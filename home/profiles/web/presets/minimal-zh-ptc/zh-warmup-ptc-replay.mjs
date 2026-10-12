/**
 * Deterministic Chinese Minimal warmup followed by PTC Code Mode.
 *
 * A fresh top-level session first runs a short sequence of synthetic warmup
 * steps with only the preset persona, persistent `bash`, and
 * `str_replace_editor`. The real user input is deferred until every replay
 * round is complete. The adapter is vetoed and `replay.json` supplies the
 * assistant reasoning/reply, so the anchor rounds cost no provider request.
 *
 * When the final warmup step ends, the agent's tool presentation switches to
 * Code Mode. The deferred real input is therefore the first request that sees
 * the single `run_code` transport and the generated SDK. The replay teaches
 * task routing, evidence updates, dependency-aware concurrency, result-surface
 * verification, visual audit discipline, and stopping rules before that request is assembled.
 *
 * Missing/invalid replay content falls back to a real warmup model call. Route
 * resolution failure skips the warmup and leaves the original input untouched.
 * Subagent sessions skip both the warmup and automatic PTC promotion.
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
  '【本会话工作方式·预热轮】',
  '这一轮只用于锚定后续轨迹，不调用真实模型或工具；所有示范轮结束后才进入 PTC Code Mode。请把下面的方式当作所有真实任务的默认决策循环，而不是只适用于代码、前端或游戏。',
  '',
  '锚定样式与执行示范：',
  '1. 全程使用简体中文 reasoning，行动句用「我需要…」「我在做…」「我准备…」；禁止「让我…」「Let me…」。',
  '2. 先锁定交付物、硬约束、用户真正消费的结果面和可观察验收；再区分已确认事实、待核实事实、推断、未知和剩余风险。',
  '3. 按任务选择适用契约：数据形状/接口、状态变化/生命周期、顺序/并发、空间/方向/时间、输出格式/用户可见结果。无关契约跳过；涉及交互或空间时，必须把内部符号映射到外部可观察语义。',
  '4. 工具前只写结果面、最多三个承重契约、已选决策、最高风险和下一动作。概念先于实现，不在 reasoning 中预写完整代码、长命令、逐行算法、未来文件草稿或最终答案草稿。',
  '5. 核心风险逐项给出结论和依据；常规项确认无异常即可一句带过；信息不足写“待确认”。reasoningEffort 保持 max，但 max 不代表每轮穷举所有枝节。',
  '6. 每个动作只做一轮分析和一轮局部复核。禁止多个实现草稿、多个答案版本、停笔重写或无新证据的重复思考；方案足够后立即行动，最终结果在思考外构建。',
  '7. 大任务先划定真实可交付范围，先做最小完整纵向切片：真实输入、核心变换、用户消费表面、状态变化验收。第一次真实运行必须早于第二个大型模块；核心闭环没过就停止扩展。',
  '8. PTC 按依赖图安排工具：当前直接传输面只有 run_code，其他工具必须在其中调用。真正独立的只读可以并发，但要保留每个结果时用 Promise.allSettled；依赖、共享状态、写入、重启和验证顺序必须串行。',
  '9. 图片文件读取与语义识图必须分开：read_image 不能代替识图。当前视觉工具是 modlens_read_image，直接传绝对图片路径和关注点；视觉工具失败且不可重试时停止视觉判断，不能用像素统计或文件大小冒充看图。',
  '10. 网络搜索只在需要最新或外部事实时使用 web_search；搜索结果必须进入决策。认证、网络错误、超时或 retryable:false 只做一次区分检查，不能在大任务中反复重试同一错误。',
  '11. 每次工具结果后只更新事实、假设、决定、未决风险和下一动作；已被证据支持的决定没有新证据不重开。测试验证适用的外部语义、状态变化、错误路径和真实消费端，不改阈值或预期来制造 PASS。',
  '12. 冲突时保留系统/开发者/工具契约，再保留用户明确硬约束、现有公共接口、质量偏好和可选增强；无法兼容就报告取舍。深度来自证据闭环，不来自更长的自我怀疑。',
  '13. 如果结果是图像、矢量图、界面或其他直接消费的产物，先做粗骨架和缩略图闭环；先判断整体识别、轮廓、纵横比例、主要体块和负空间，再做按钮、文字、颜色等局部细节。',
  '14. 视觉模型指出整体问题后，局部修复不能清除全局风险；每次复检都要重新做完整开放式整体审计。禁止把提示词缩成只问一个区域、只报告列出的项目或“现在是否正确”。',
  '15. 对象存在、对称、OCR、节点、像素统计、文件大小和空 uncertainty 只能证明局部事实；不能据此推出目标身份、比例、完成度或视觉质量。不要无证据把批评解释成“设计意图”。',
  '16. 当前请求头只给 run_code 时，首个工具调用必须是 run_code；所有 bash、编辑、搜索和识图都放在 tools.* 函数体中，不能调用旧会话记忆中的直接工具名。',
  '17. 首轮 reasoning 不预写完整代码、坐标、尺寸、组件清单或未来文件；只决定概念结构、关键不变量、最高风险和最小首轮动作。',
  '18. 对 SVG、HTML、JSON、配置或其他结构化产物，在字段层做变换后再序列化；不要用全局数字替换代替坐标或尺寸变换。序列化后检查尺寸、坐标、闭合关系和真实消费端。',
  '19. 要求还原现实对象或标准布局且没有参考时，先获取参考或明确是风格化版本；至少核对包围盒、纵横比例、主要体块和缩略图识别。',
  '20. 预热结束后的真实首步，如果工作目录、工具面和最小路线已确定，reasoning 通常不超过约 600 个中文字符；只写结果面、契约、最高风险和下一动作，然后立即调用 run_code。',
  '21. 不要把 max 当成“先把未来实现全部想完”。只要下一动作清楚，就停止当前 reasoning；坐标、尺寸、函数、算法、模板和文件草稿全部推迟到工具参数。',
  '',
  '现在在 reasoning 中示范一次清晰的通用工作循环：只写概念、契约、风险和下一动作，不写具体代码；最后简短确认。不要调用工具。',
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
  facts: '输入形状已确认；只更新受影响的假设。',
  parallel: '独立读取已分别结算；没有共享写入。',
  slice: '最小纵向闭环已确定；外围工作尚未开始。',
  recovery: '失败已归因到可区分假设；只保留下一项检查。',
  synthesis: '范围、证据边界和下一步已收束；未验证项保留。',
}
const LONG_COMPOSITE_REASONING = [
  '我正在处理一个本地证据整理与交付工作台。用户真正消费的不是某个内部脚本、某张列表或某个局部页面，而是一份能让人看清事实来源、判断结论边界并继续追踪未决项的可用结果。我要先把交付物收窄为：可信的证据集合、可浏览的结论视图、可复现的关键行为，以及明确区分已验证和未验证的交付说明。这里不承诺覆盖所有历史材料，也不把“页面能打开”误称为研究完成。范围足够清楚后，我才决定下一动作。',
  '当前已确认的只有任务目标、可访问的本地工作区以及需要在现有约束内交付这一事实。材料格式、来源许可、重复程度、时间覆盖范围、是否存在敏感片段、界面是否已有可复用骨架，都仍是未知。用户没有提供外部来源已获授权的证据，因此我不能把网络补充当作默认输入，也不能把无法核验的描述写成事实。我会把已确认、待读取、可推断和必须保留的风险分开记录，避免后续把一次成功读取扩大为整体可信。',
  '我先看环境，而不是先设计很大的界面。我要确认运行入口、现有依赖、数据位置、测试方式和可用的视觉检查面。这里有几项互不依赖的只读：目录结构、清单元数据、已有测试说明、样例材料的头部形状。它们可以同时读取，结果需要分别保留，因为一个缺失并不否定其他读取。写入、依赖安装、进程启动和验证则必须留到读取结论之后，不能为了并发把有顺序的动作混在一起。',
  '环境探针的目的不是盘点所有文件，而是回答会改变路线的问题。如果已经存在稳定的应用骨架和解析入口，我会沿用它；如果只有零散材料，我会先建立最小可消费的切片；如果运行工具缺失，我会记录该限制并选择不依赖它的验证面。这里不需要猜测具体库或预写未来目录。我只需要得到足够证据来决定是接入现有流程，还是做一个小而完整的本地工作台。任何不能改变这个决定的信息都暂时停止收集。',
  '读取结果假设显示材料包含若干结构不同的记录：有些带来源，有些只有摘要，有些内容相近但时间不同。此时我不会立即把它们合并为一个“真相”。我会先定义面向用户的最小语义：每条记录需要能说明它从哪里来、表达什么、在什么时间被观察、为什么被归到某个主题，以及当前可信度处于什么状态。若来源缺失，就保留为待核验；若两个材料文字相似但来源不同，就保留关联而不是擅自去重；若时间矛盾，就把冲突显示为事实而不是强行选一个版本。',
  '接下来有两条可行路线。第一条是先建完整分类、筛选、导入和报告体系，优点是最终形态丰富，风险是会在数据语义和消费面尚未证明之前制造很多不可验证的结构。第二条是先做最小纵向切片：接收一小组代表性材料，形成可读的证据条目，展示来源和结论边界，再用一个真实交互验证筛选或展开是否符合用户理解。第二条更符合当前证据条件，我选择它，并关闭完整体系这条分支，直到核心切片通过。',
  '最小切片的承重契约需要明确。数据契约是保留原始材料与整理后的展示信息之间的可追溯关系，不能只留下摘要。接口契约是输入异常、缺失来源和空集合都有稳定的可观察结果，而不是悄悄消失。状态契约是用户切换主题或证据等级后，当前结果、计数和空状态保持一致。顺序契约是读取完成之前不把临时推断标成结论。用户可见契约是每个结论都能回到它依赖的材料，且未验证项不会伪装成已确认。',
  '我还要处理来源和许可证风险。外部材料即使能访问，也不代表可以复制、长期保存或作为事实依据；本地材料即使存在，也可能只是用户的工作草稿。我要把来源显示与内容消费分开：来源信息用于让用户判断出处，内容本身只在权限和范围允许时进入交付表面。对没有许可或无法确定归属的材料，最小切片可以展示“待确认来源”和简短定位信息，但不能扩展成再分发或确定性结论。这不是额外流程，而是防止交付物在用户真正使用时越界。',
  '当前可以开始第一个行动：读取少量代表性材料和已有界面边界，确认输入能否形成一条完整的可追溯记录。这个行动的产物不是最终工作台，而是一组足以验证数据形状、来源展示和空状态的真实样本。若材料证明结构稳定，我再建立展示骨架；若材料证明结构差异大，我只增加一个规范化边界，不急着增加筛选或视觉细节。我要在工具里完成这些读取和最小转换，reasoning 到此停止，不把具体实现预写在这里。',
  '假设第一轮证据显示，部分记录缺少时间，另一些记录含有多个可能来源。这个结果不会推翻最小切片，因为它恰好验证了“未知需要可见”的契约。我会把缺失时间视为可显示的未知，而不是填入当前日期；把多个来源视为待选择或并列证据，而不是通过文字相似度自动选一个。现在的关键风险从“能否读取”转为“用户会不会误解聚合后的确定性”。因此下一步应该优先验证展示的限定语和来源回链，而不是先做更多类别。',
  '展示骨架应当让用户一眼区分三层：材料本身、从材料得出的有限观察、仍未关闭的问题。这样既能支持快速浏览，也不会把内部整理过程藏起来。整体结构先服务于扫描和比较，局部控件只服务于收窄范围或展开证据。我要避免把每项都包成孤立的装饰卡片，也避免用醒目的颜色暗示不存在的可信度差异。用户需要的是工作面，不是宣传页；信息密度应当来自清楚的层级、稳定排序和可追溯关系。',
  '对于交互，我只选择一条能验证状态变化的路径，例如从主题视图进入某条结论，再回到来源集合。这个路径必须证明筛选条件、可见条目、空状态和回退动作之间没有错位。若没有真实浏览器或运行表面，我只能验证结构和状态模拟，并把交互标为未验证；我不能用静态截图或节点数量代替真实使用。若运行表面可用，我会先测试最短路径，再决定是否增加更多控制项。这样可以尽早发现状态与显示不同步，而不是在很多功能之后才发现基础语义错误。',
  '视觉验收同样分层。结构层检查内容是否保持来源、观察和未决项的对应关系；行为层检查选择、过滤、展开和空状态是否按契约变化；视觉层检查用户实际看到的层级、阅读顺序、密度、截断和小尺寸下的整体识别。视觉层不能只问某个按钮是否存在，而要先判断页面实际看起来像什么、证据与结论的主次是否清楚、是否有关键内容被挤压或误导性的强调。局部文本正确不等于整体工作流可理解。',
  '如果视觉检查指出整体层级不清，我不会用“信息很多所以本来就复杂”解释。需要先区分两种可证伪假设：一种是内容分组本身混乱，另一种是分组正确但呈现顺序和间距没有表达出来。一次最小区分检查足够：在不改变数据的前提下观察用户主视图能否先识别结论、再识别证据、最后识别未决项。若顺序仍不清，则问题在呈现；若顺序清楚但某些记录仍难归类，则回到数据边界。不要同时重写数据和界面，否则失去因果证据。',
  '工具失败时，我也只保留两个可证伪方向。例如读取失败可能来自路径边界，也可能来自材料格式；我先做一次不修改内容的定位检查，判断失败发生在访问前还是解析后。若访问正常而解析失败，就收窄到输入形状；若访问本身失败，就不继续假设材料语义。对于网络、认证、超时或来源站点拒绝，最多做一次区分检查，然后把外部补充标为未验证，继续完成本地可交付切片。反复重试同一个失败不会增加证据。',
  '随着最小切片通过，我才考虑扩展。扩展也必须由用户结果面推动：若用户需要对比时间变化，就增加时间维度并说明缺失值；若用户需要复核来源，就增加来源筛选和冲突提示；若用户只需要当前结论，就保持工作面紧凑，不为了看起来完整而增加仪表盘、导出或复杂配置。每一项扩展都要回答它改变了什么决策、依赖什么证据、怎样在真实消费面验证。没有这个答案的增强先关闭。',
  '我会持续检查范围是否漂移。研究、结构化数据、界面、运行和视觉验收很容易把一次任务变成长期产品计划。当前承诺只是交付一个能帮助用户判断证据边界的最小工作台，而不是建立永久知识库、自动判定真实性或替代人工许可审查。若用户的材料不足以支持更强结论，我要明确写出“未验证”和需要的下一条证据。诚实的边界是交付物的一部分，不是失败后的附注。',
  '在准备交付前，我会把证据按结论强度复核一次。已验证的部分必须同时有材料、结构和行为上的支撑；只通过解析或测试的部分只能称为结构通过；只通过视觉检查的部分只能称为呈现可读；没有运行或来源验证的部分保持未验证。若任何承重结论只依赖单一弱证据，就降低结论而不是补一段自信描述。这里的停止条件是：核心切片可用、已知风险被标注、验证面与用户结果面匹配，而不是所有可能功能都存在。',
  '现在我重新看一次风险优先级。最高风险仍是把不完整材料呈现成确定事实，其次是状态变化与可见证据不一致，再次才是视觉细节。这个排序决定最后的验证顺序：先检查来源与限定语是否贯穿主路径，再检查切换后证据和计数是否一致，最后做整体视觉审计和局部回归。若第一项失败，后两项即使通过也不能交付；若前两项通过而视觉仍不清楚，就把可读性标为未完成，不用结构通过代替视觉通过。',
  '我还会检查决策记录是否可被后来者理解。它不需要展开所有想过的分支，只需保留为什么选择最小切片、哪些材料因来源不足未进入结论、哪些验证已经实际完成、哪些风险需要下一次读取。这样用户或后续执行者能沿着证据继续，而不是从一个漂亮但无法解释的页面重新猜测。决定一旦有证据支持就关闭，除非新材料改变输入、权限或用户目标；这能避免每次工具结果回来都重写整个方案。',
  '此时没有理由继续在 reasoning 中推导实现。结果面、范围、承重契约、风险排序、最小切片和验证顺序都已足以决定下一动作。我将调用私有锚点，把这条长链收束为“范围与证据边界已确认”，随后只做短更新。真正任务中的具体读取、转换、写入、运行和验证必须进入工具参数与工具结果；这里不再提前写任何可复制的实现。',
  '资源约束也要提前纳入决策，但不能把它变成泛泛的性能担忧。我要先辨认哪一项资源真正限制结果：可能是材料数量、图像体积、启动时间、浏览器内存、人工复核时间，或者只是用户一次能理解多少证据。对每一种限制，我只采取与结果面直接相关的措施。材料太多时优先保留来源和摘要，不把所有正文塞进首次视图；视觉素材太重时先验证缩略消费面；复核时间不足时把高风险来源排在前面。没有证据表明资源已成瓶颈，就不引入缓存层、后台队列或复杂分页。',
  '如果现有结构中存在旧格式或部分迁移痕迹，我不会默认重写。先确认旧格式是否仍被真实消费、是否能无损读取、是否有稳定的转换边界，以及失败时能否恢复。两条路线仍然足够：在读取时兼容旧材料，或先做一次显式转换。只有当旧材料会持续进入主路径且兼容逻辑会污染核心语义时，转换才值得承担风险；否则保留适配层并标记退出条件。任何会删除、覆盖或不可逆重排材料的动作都不能在未验证备份和恢复路径前发生。',
  '异常输入不是为了覆盖所有想象出来的情况，而是围绕已发现的边界。空材料、只有空白的材料、缺少来源、重复来源、日期无法解释、内容不可读和结构被截断，都会影响用户看到的结果。我要让这些情况以稳定、可说明的状态出现，而不是让界面静默空白或让汇总数字掩盖缺口。相反，对从未出现也不会改变路线的罕见形状，不为它们提前建一层抽象。简单的系统更容易把未知保持为未知，也更容易在新证据到来时做局部修正。',
  '协作边界同样属于可观察契约。后来接手的人需要知道哪些判断来自材料、哪些来自整理规则、哪些只是当前会话的工作假设。我会让交接信息靠近它对应的结论，而不是写成脱离上下文的大段说明。若需要用户确认来源或选择冲突版本，就把问题收敛为一两个会改变路线的选择，并说明每个选择对范围的影响。不能把大量开放问题一次抛给用户，也不能在缺少授权时替用户决定材料归属。等待确认期间，本地已验证的切片仍可继续，但不能把待确认部分混入最终结论。',
  '审计不是额外复制一份日志，而是保证每一个重要结果都能说明它的来处和验证状态。我要避免记录不必要的敏感原文、访问令牌或临时环境细节；这些既不帮助用户判断结果，也扩大泄露面。真正需要保留的是可复现的输入范围、处理时的规则版本、验证动作和剩余风险。若某次视觉或行为验证无法重现，我不会用模糊的“看起来没问题”填补，而是记录它尚未形成稳定证据。这样后续复核可以回到同一个边界，而不用依赖记忆。',
  '对于排序和聚合，我会先问用户如何理解优先级。最新不一定最重要，来源最多不一定最可信，文字最长也不一定证据最强。最小切片可以采用稳定、可解释的默认顺序，例如先展示有明确来源的材料，再展示待核验项，同时把排序依据写成用户可见的说明。只要排序规则会影响结论消费，就必须在测试中覆盖切换或边界，而不是只验证列表长度。若用户没有给出偏好，我选择最保守、最容易解释的规则，并把它标为当前决定而非客观真理。',
  '运行验证必须贴近真正消费端。单元级检查可以证明某一条材料被识别、某一段文本被保留，但它不能证明用户从主视图进入证据时看到的是同一件事。我要至少走一条完整路径：输入进入、整理发生、结果显示、状态改变、来源回看、空或错误状态被看见。若该路径需要手动操作，就记录操作前后的外部变化；若只能在自动化环境中运行，也要确认自动化没有绕过实际界面。通过一条真实路径比许多彼此孤立的内部断言更能发现断裂。',
  '视觉复核结束后，我会再做一次文本与语义复核。视觉上层级清楚不意味着限定语准确；文字上每个词正确也不意味着来源关系没有被误读。因此两者不能相互替代。我要检查用户最可能据此做决定的句子是否把证据强度说清，检查未验证标签是否足够靠近相关结论，检查空状态是否告诉用户缺少什么而不是只说没有数据。若视觉检查没有能力判断细小文本，就降低该项结论的强度，并采用可由结构和行为共同支持的保守表达。',
  '当一个工具结果与预期冲突时，我先问它改变的是事实、实现还是验收。如果材料读取结果改变事实，我更新范围；如果运行结果暴露实现错误，我修正实现后重跑同一验证；如果视觉结果表明验收不充分，我保留原验收并增加针对性的观察。三者不能混为一谈。尤其不能因为测试通过就宣布用户可见结果已经通过，也不能因为某个页面好看就宣布来源可信。每次更新只应影响受证据触及的那一层，这能让复杂任务保持可解释。',
  '最后的交付语言也需要和证据匹配。我会先说明已完成的最小闭环，再说明实际运行和消费面验证的结果，然后单列未验证来源、未覆盖的材料范围、外部资源限制和需要用户决定的事项。不会把后续建议伪装成当前已完成工作，也不会把“没有看到错误”写成绝对正确。若用户下一步需要扩大范围，交付中的证据边界应当足以让新增工作从正确位置继续，而不是重新发明一套规则。到这里，所有会改变下一动作的分支都已经关闭或标明等待条件。',
  '我还要防止“代表性样本”被误解为统计结论。最小切片使用少量材料只是为了验证路径和语义，不足以说明全部材料都符合相同模式。展示中应当把样本范围、选择依据和未读取部分说清楚；验证中也要把样本通过与全量通过分开。若后续发现新的材料形状，先判断它是否破坏已建立的输入和展示契约，再决定扩展规范化还是把它留在待处理队列。这样能避免早期成功被放大成对未知总体的承诺。',
  '时间维度会引入另一种常见误导：材料的创建时间、被收集时间、描述事件的时间和用户最后查看时间不一定相同。我不会把它们压成一个貌似精确的日期，也不会在缺失时用相邻记录猜测。工作台只展示已经知道的时间语义；不能确定的部分标为未知，并在排序或比较时说明限制。只有用户确实需要时间趋势，才把时间作为主路径的一部分，并用跨越缺失和冲突的样本验证排序不会伪造连续性。',
  '一旦涉及图片、扫描件或其他视觉材料，读取文件与理解内容是两件事。文件可打开、尺寸正常或文字能被局部识别，只证明局部技术事实；它不能证明图像支持了某个结论。我要把视觉材料的可读性、所见内容和与结论的关联分开。若没有可靠的语义视觉检查，就只说明文件存在并可访问，不把它升格为证据。若视觉检查指出整体构图或关键信息不可辨认，局部清晰区域也不能清除这个风险。',
  '在没有网络或网络来源受限时，本地工作仍然可以完成有价值的部分，但我必须避免假装做过外部核验。我会明确哪些结论只基于本地材料，哪些需要以后与原始来源、许可证或权威记录比对。网络恢复后也不应该盲目补抓所有内容，而应从会改变高风险结论的少量来源开始。每一次外部检索都需要进入后续决策；如果结果没有改变判断，就不继续扩大查询。这样既控制成本，也避免把搜索次数当作研究深度。',
  '此刻长链的价值不是让未来任务照抄这段话，而是示范一种可停止的推进方式：每一步先说明它服务的结果面，读取后只更新被证据触及的决定，遇到风险就选择能区分的最小检查，确定后立即把实现交给工具。细节会因任务而异，但边界、契约、验证和诚实交付的关系保持稳定。我的下一动作已经唯一：调用综合锚点，然后根据固定证据做一句更新，结束预热并把真实任务交给 PTC。',
  '我现在停止继续展开。风险、范围、已知事实、待验证来源和消费端验收都已有对应去处；继续推演只会把应该交给工具确认的细节提前写出来。',
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
