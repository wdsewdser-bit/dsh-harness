import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, closeSync, unlinkSync, readSync } from 'node:fs'
import { resolve, join, dirname, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpc } from './usage-runtime-rpc.mjs'
import { decodeJournal } from '../home/profiles/web/plugins/team-usage.mjs'

export const LIMITS = Object.freeze({ requests: 16, inputTokens: 1000000, outputTokens: 24000, descendants: 1, concurrency: 1, durationMs: 600000 })
export const ROUTE = Object.freeze({ provider: 'opencodego', model: 'deepseek-v4.1-flash' })
export const AGENT_PRESET = 'ptc'
const BASE = 'D:/dsh-test', HOME = BASE + '/home'
const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex')
const expect = (x, code) => { if (!x) throw new Error(code) }
const load = file => JSON.parse(readFileSync(file, 'utf8'))
const save = (file, value) => { const temp = file + '.tmp'; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n'); renameSync(temp, file) }
const pause = ms => new Promise(r => setTimeout(r, ms))
const pathEqual = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
export const RPC_ARGUMENT_NAMES = Object.freeze({ 'workspace/create': 'request', 'session/create': 'request', 'session/selectModel': 'request', 'session/prompt': 'request', 'session/list': '_request', 'session/projections': 'request', 'session/cancel': 'request', 'session/updateQueue': 'request', 'settings/describe': null })
export function wireArguments(method, args = {}) {
  expect(Object.hasOwn(RPC_ARGUMENT_NAMES, method), 'LAB_RPC_METHOD_NOT_ALLOWED')
  const name = RPC_ARGUMENT_NAMES[method]
  if (name === null) { expect(Object.keys(args).length === 0, 'RPC_NO_ARGUMENTS_REQUIRED'); return {} }
  return { [name]: args }
}
export async function labRpc(method, args = {}, options) { return rpc(method, wireArguments(method, args), options) }

export function labPath(workspace) {
  const path = resolve(workspace), rel = relative(resolve(BASE + '/workspaces'), path)
  expect(!isAbsolute(rel) && /^clm-lab-20261001-[a-z0-9-]+$/i.test(rel), 'LAB_WORKSPACE_BOUNDARY')
  return path
}

export function makeFixture() {
  const lines = Array.from({ length: 400 }, (_, i) => `trace step=${String(i + 1).padStart(4, '0')} fixture=clm-lab component=cache outcome=ok`)
  lines[1] = 'WARN CONFIG fixture=clm-20261001 expected_checksum=7e2a required_route=flash'
  lines[172] = 'ERROR UNIQUE_FAILURE E_CLM_173 file=src/cache.ts:41 expected=7e2a actual=91bf'
  lines[398] = 'WARN FINAL fixture=clm-20261001 status=blocked reason=checksum-mismatch'
  return { version: 1, text: lines.join('\n'), sha256: hash(lines.join('\n')), lines: 400,
    oracle: { error_code: 'E_CLM_173', error_line: 173, expected_checksum: '7e2a', actual_checksum: '91bf', final_status: 'blocked', quotes: [2, 173, 399].map(line => ({ line, text: lines[line - 1] })) } }
}

export function checkOracle(answer, fixture) {
  const reasons = []
  for (const key of ['error_code', 'error_line', 'expected_checksum', 'actual_checksum', 'final_status']) if (answer?.[key] !== fixture.oracle[key]) reasons.push(key)
  for (const quote of fixture.oracle.quotes) if (!answer?.quotes?.some(row => row.line === quote.line && row.text === quote.text)) reasons.push('quote-' + quote.line)
  for (const row of answer?.quotes ?? []) if (fixture.text.split('\n')[row.line - 1] !== row.text) reasons.push('invalid-quote')
  return { passed: reasons.length === 0, reasons }
}

export function prepare(workspace) {
  workspace = labPath(workspace)
  expect(!existsSync(join(workspace, 'lab-state.json')), 'LAB_ALREADY_PREPARED')
  mkdirSync(workspace, { recursive: true })
  const fixture = makeFixture(), rootSessionId = 'session-' + randomUUID()
  save(join(workspace, 'fixture.json'), fixture)
  writeFileSync(join(workspace, 'fixture.log'), fixture.text + '\n')
  const plan = { version: 1, workspace, route: ROUTE, limits: LIMITS, fixtureSha256: fixture.sha256,
    stages: [], schemaFiles: [], protection: { sessionLocalModelOnly: true, globalThinkingChanged: false, originalSessions: 'excluded', wireHttpRequests: 'unknown; logical llm receipts only' },
    pending: ['final context_manage schema', 'final compact/operation_id schemas', 'schema-bound stage prompts and assertions', 'root-appliedSessionIds setup after create'] }
  save(join(workspace, 'lab-plan.json'), plan)
  save(join(workspace, 'lab-state.json'), { version: 1, workspace, rootSessionId, created: false, stages: {}, phase: 'prepared', startedAt: null })
  return { workspace, rootSessionId, phase: 'prepared', modelRequests: 0 }
}

export function validatePlan(plan, fixture, requireStages = false) {
  labPath(plan.workspace)
  expect(JSON.stringify(plan.route) === JSON.stringify(ROUTE), 'ROUTE_DRIFT')
  expect(JSON.stringify(plan.limits) === JSON.stringify(LIMITS), 'LIMIT_DRIFT')
  expect(fixture.sha256 === hash(fixture.text) && fixture.sha256 === plan.fixtureSha256 && fixture.text.split('\n').length === 400, 'FIXTURE_DRIFT')
  expect(readFileSync(join(plan.workspace, 'fixture.log'), 'utf8') === fixture.text + '\n', 'FIXTURE_FILE_DRIFT')
  expect(checkOracle(fixture.oracle, fixture).passed, 'FIXTURE_ORACLE_INVALID')
  expect(Array.isArray(plan.stages) && Array.isArray(plan.schemaFiles), 'PLAN_SHAPE')
  if (requireStages) expect(plan.stages.length > 0 && plan.schemaFiles.length > 0 && plan.pending.length === 0, 'FINAL_SCHEMA_AND_STAGES_REQUIRED')
  const ids = new Set(), totals = { requests: 0, inputTokens: 0, outputTokens: 0 }
  for (const stage of plan.stages) {
    expect(typeof stage.id === 'string' && /^[a-z0-9-]+$/.test(stage.id) && !ids.has(stage.id), 'STAGE_ID'); ids.add(stage.id)
    expect(typeof stage.prompt === 'string' && stage.prompt.trim() && stage.prompt.length <= 60000, 'STAGE_PROMPT')
    expect(stage.mode === 'shadow' || stage.mode === 'apply', 'STAGE_MODE')
    for (const key of Object.keys(totals)) { expect(Number.isSafeInteger(stage.reserve?.[key]) && stage.reserve[key] > 0, 'STAGE_RESERVE'); totals[key] += stage.reserve[key] }
    expect(Array.isArray(stage.receipts) && stage.receipts.length > 0, 'CANONICAL_RECEIPT_ASSERTIONS_REQUIRED')
    for (const assertion of stage.receipts) expect(typeof assertion.tool === 'string' && typeof assertion.pointer === 'string' && Object.hasOwn(assertion, 'equals'), 'RECEIPT_ASSERTION_SHAPE')
  }
  for (const key of Object.keys(totals)) expect(totals[key] <= LIMITS[key], 'PLANNED_BUDGET_' + key)
  for (const schema of plan.schemaFiles) expect(typeof schema.path === 'string' && schema.sha256 === hash(readFileSync(schema.path)), 'SCHEMA_DRIFT')
  if (requireStages || plan.runtimeBinding) validateRuntimeBinding(plan.runtimeBinding, plan.schemaFiles)
  return { valid: true, ready: plan.stages.length > 0 && plan.pending.length === 0, stages: plan.stages.length, totals }
}

export function validateRuntimeBinding(binding, schemaFiles) {
  expect(binding && binding.language === 'typescript' && binding.agentPreset === AGENT_PRESET && binding.runtimeKind === 'dsh-ptc-runtime-node', 'PTC_RUNTIME_BINDING_REQUIRED')
  expect(binding.route?.provider === ROUTE.provider && binding.route?.model === ROUTE.model, 'PTC_ROUTE_BINDING_REQUIRED')
  const schemaHash = binding.toolsSchemaBindings?.context_manage
  expect(/^[a-f0-9]{64}$/.test(schemaHash) && schemaFiles?.some(s => /(?:^|[\\/])context-workspace\.loaded\.schema\.json$/.test(s.path) && hash(load(s.path)) === schemaHash), 'PTC_SCHEMA_BINDING_REQUIRED')
  expect(binding.sdkSha256 === null || /^[a-f0-9]{64}$/.test(binding.sdkSha256), 'PTC_SDK_BINDING_REQUIRED')
  expect(binding.schemaCount === null || Number.isSafeInteger(binding.schemaCount) && binding.schemaCount > 0, 'PTC_SDK_BINDING_REQUIRED')
  return binding
}

export function workspaceJournalDirectory(workspace) {
  // This boundary allows only ASCII lab paths; mirror rc2 projectKey separator runs.
  const readable = workspace.replace(/[\\/:]+/g, '-').replace(/^-+/, '')
  expect(/^[A-Za-z0-9._-]+$/.test(readable), 'LAB_PROJECT_KEY_CHARACTERS')
  return join(HOME, 'sessions', '--' + readable.slice(0, 251) + '--')
}

export function decodeEvents(bytes) {
  const text = bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? decodeJournal(bytes) : bytes.toString('utf8')
  return text.split('\n').filter(Boolean).map(JSON.parse)
}

export function ownJournalRows(rows, header) {
  if (!header.isSeeded) return { rows, inheritedBoundarySeq: null }
  const marker = rows.findLast(r => r.type === 'session/end-seed' && r.data?.inherited === true)
  expect(Number.isInteger(marker?.seq), 'SEEDED_CHILD_CUT_REQUIRED')
  return { rows: rows.filter(r => Number.isInteger(r.seq) && r.seq > marker.seq), inheritedBoundarySeq: marker.seq }
}

export function verifyLabLineage(journals, state) {
  const root = journals.find(j => j.header.id === state.rootSessionId)
  expect(root && pathEqual(root.header.cwd, state.workspace) && !root.header.parentSession && !root.header.isSeeded, 'FRESH_ROOT_REQUIRED')
  const approved = [root], remaining = journals.filter(j => j !== root)
  for (const journal of remaining) {
    expect(pathEqual(journal.header.cwd, state.workspace) && journal.header.parentSession === root.header.id && journal.header.origin === 'subagent' && journal.header.delegationDepth === 1, 'LAB_LINEAGE_BOUNDARY')
    approved.push(journal)
  }
  expect(approved.length - 1 <= LIMITS.descendants, 'DESCENDANT_LIMIT')
  return approved
}

function readLabJournals(state) {
  const dir = workspaceJournalDirectory(state.workspace)
  if (!existsSync(dir)) return []
  const journals = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
    const file = join(dir, entry.name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    expect(statSync(file).size <= 16000000, 'LAB_JOURNAL_TOO_LARGE')
    const bytes = readFileSync(file), rows = decodeEvents(bytes), header = rows.find(r => r.type === 'session')
    expect(header?.id === entry.name, 'JOURNAL_HEADER_ID')
    journals.push({ file, sha256: hash(bytes), header, ...ownJournalRows(rows, header) })
  }
  return journals.length ? verifyLabLineage(journals, state) : []
}

const ledgerCache = new Map()
function ledgerRows(sessionIds) {
  const dir = join(HOME, 'usage-ledger'), rows = []
  for (const file of readdirSync(dir).filter(f => /^requests-.*\.jsonl$/.test(f))) {
    const path = join(dir, file), size = statSync(path).size
    expect(size <= 50000000, 'LEDGER_FILE_TOO_LARGE')
    const cached = ledgerCache.get(path) ?? { offset: 0, pending: Buffer.alloc(0), rows: [] }
    expect(size >= cached.offset, 'LEDGER_TRUNCATED')
    if (size > cached.offset) {
      const fd = openSync(path, 'r'), bytes = Buffer.alloc(size - cached.offset)
      try { expect(readSync(fd, bytes, 0, bytes.length, cached.offset) === bytes.length, 'LEDGER_SHORT_READ') } finally { closeSync(fd) }
      const content = Buffer.concat([cached.pending, bytes]), last = content.lastIndexOf(10)
      if (last >= 0) for (const line of content.subarray(0, last).toString('utf8').split('\n').filter(Boolean)) cached.rows.push({ ...JSON.parse(line), ledgerFile: path })
      cached.pending = content.subarray(last + 1); cached.offset = size; ledgerCache.set(path, cached)
    }
    rows.push(...cached.rows.filter(row => sessionIds.has(row.sessionId)))
  }
  return rows
}

export function measureBudget(rows) {
  const requests = new Map()
  for (const row of rows.filter(r => r.event === 'start' || r.event === 'terminal')) {
    expect(typeof row.requestId === 'string', 'LEDGER_REQUEST_ID')
    const pair = requests.get(row.requestId) ?? {}; expect(!pair[row.event], 'DUPLICATE_LEDGER_EVENT'); pair[row.event] = row; requests.set(row.requestId, pair)
  }
  let inputTokens = 0, outputTokens = 0, unknown = 0, unknownFields = 0, active = 0
  for (const pair of requests.values()) {
    if (!pair.terminal) { active++; continue }
    const u = pair.terminal.usage
    if (!u || ['inputTokens', 'cacheReadTokens', 'outputTokens'].some(k => !Number.isFinite(u[k]))) { unknown++; continue }
    inputTokens += u.inputTokens + u.cacheReadTokens; outputTokens += u.outputTokens
    if (Number.isFinite(u.cacheWriteTokens)) inputTokens += u.cacheWriteTokens
    else unknownFields++
  }
  return { requests: requests.size, inputTokens, outputTokens, unknown, active, ...(unknownFields ? { unknownFields } : {}) }
}

export function budgetStopReason(usage, reserve = { requests: 0, inputTokens: 0, outputTokens: 0 }, deadline = Infinity, now = Date.now()) {
  if (now >= deadline) return 'DURATION_LIMIT'
  if (usage.unknown) return 'UNKNOWN_USAGE_STOP'
  for (const key of ['requests', 'inputTokens', 'outputTokens']) if (usage[key] + reserve[key] >= LIMITS[key]) return 'BUDGET_' + key
  if (usage.active > LIMITS.concurrency) return 'CONCURRENCY_LIMIT'
  return null
}

const pointer = (value, path) => path === '' ? value : path.split('/').slice(1).reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], value)
const clean = value => {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/secret|authorization|cookie|api.?key|credential/i.test(k)).map(([k, v]) => [k, clean(v)]))
  return value
}
const fixtureQuotesFor = (args, texts) => {
  if (typeof args?.file_path !== 'string') return []
  const file = resolve(args.file_path), parent = dirname(file)
  try { labPath(parent) } catch { return [] }
  if (!pathEqual(file, join(parent, 'fixture.log')) || args.limit !== 1) return []
  return makeFixture().oracle.quotes.filter(q => args.offset === q.line && texts.some(t => t.includes(q.text)))
}

export function canonicalReceipts(rows) {
  const calls = new Map(rows.filter(r => r.type === 'tool/call').map(r => [r.data.callId, r]))
  const native = rows.filter(r => r.type === 'tool/result').map(row => {
    const message = row.data.message, call = calls.get(message?.toolCallId), texts = (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text)
    expect(call, 'UNPAIRED_TOOL_RESULT')
    const parsed = texts.flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } })
    let args; try { args = JSON.parse(call.data.arguments) } catch { args = null }
    return { callId: call.data.callId, tool: call.data.name, callSeq: call.seq, resultSeq: row.seq, turn: row.data.turn, step: row.data.step,
      argumentsSha256: hash(call.data.arguments), action: args?.action ?? null, isError: message.isError === true,
      resultSha256: hash(texts), values: clean(parsed), meta: clean(row.data.meta ?? null), errorCode: row.data.error?.code ?? null,
      fixtureQuotes: call.data.name === 'read' ? fixtureQuotesFor(args, texts) : [], errorMarkers: texts.some(t => t.includes('message-operation-conflict')) ? ['message-operation-conflict'] : [] }
  })
  const starts = new Map(rows.filter(r => r.type === 'tool/ptc-dispatch-start').map(r => [r.data.subCallId, r]))
  const ptc = rows.filter(r => r.type === 'tool/ptc-dispatch').map(row => {
    const d = row.data, started = starts.get(d.subCallId)
    expect(started && started.data.rootCallId === d.rootCallId && started.data.parentCallId === d.parentCallId && started.data.name === d.name, 'UNPAIRED_PTC_DISPATCH')
    const texts = (d.content ?? []).filter(b => b.type === 'text').map(b => b.text)
    const parsed = texts.flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } })
    return { kind: 'canonical-ptc-subcall', callId: d.subCallId, rootCallId: d.rootCallId, parentCallId: d.parentCallId, tool: d.name, callSeq: started.seq, resultSeq: row.seq,
      argumentsSha256: hash(d.arguments), action: d.arguments?.action ?? null, isError: d.isError === true,
      resultSha256: hash(texts), values: clean(parsed), meta: null, errorCode: d.error?.code ?? null,
      fixtureQuotes: d.name === 'read' ? fixtureQuotesFor(d.arguments, texts) : [], errorMarkers: texts.some(t => t.includes('message-operation-conflict')) ? ['message-operation-conflict'] : [] }
  })
  return [...native, ...ptc].sort((a, b) => a.resultSeq - b.resultSeq)
}

export function checkReceipts(receipts, assertions) {
  return assertions.map(a => ({ tool: a.tool, pointer: a.pointer, passed: receipts.some(r => r.tool === a.tool && (a.sessionId === undefined || r.sessionId === a.sessionId) && (a.action === undefined || r.action === a.action) && (a.isError === undefined || r.isError === a.isError) && JSON.stringify(pointer(r, a.pointer)) === JSON.stringify(a.equals)) }))
}

export function checkReceiptRelations(receipts, relations = []) {
  const select = spec => {
    const matches = receipts.filter(r => r.tool === spec.tool && (spec.action === undefined || r.action === spec.action) && (!spec.where || JSON.stringify(pointer(r, spec.where.pointer)) === JSON.stringify(spec.where.equals)))
    const row = spec.pick === 'last' ? matches.at(-1) : matches[0]
    return row ? pointer(row, spec.pointer) : undefined
  }
  return relations.map(relation => {
    const left = select(relation.left), right = select(relation.right)
    return { name: relation.name, passed: left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right) }
  })
}

async function readSnapshot(state) {
  const journals = readLabJournals(state), ids = new Set([state.rootSessionId, ...journals.map(j => j.header.id)])
  const rows = ledgerRows(ids), usage = measureBudget(rows)
  return { journals, rows, usage, ids }
}

async function cancelLab(state, snapshot, reason, callRpc) {
  state.phase = 'stopped'; state.stopReason = reason; save(join(state.workspace, 'lab-state.json'), state)
  // Only root ID minted before create and children proved by fresh isolated headers.
  for (const id of snapshot.ids) await callRpc('session/cancel', { sessionId: id }).catch(() => {})
}

export function validateRuntimeReceipt(receipt, stage, state, { now = Date.now(), expectedModuleHash, runtimeBinding, isProcessAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } } } = {}) {
  expect(receipt?.source === 'loaded-runtime-services' && receipt.labSessionId === state.rootSessionId, 'LOADED_RUNTIME_LAB_RECEIPT_REQUIRED')
  const captured = Date.parse(receipt.capturedAt)
  expect(Number.isFinite(captured) && captured <= now && now - captured <= 60000, 'FRESH_RUNTIME_RECEIPT_REQUIRED')
  const facts = receipt.services?.contextWorkspace
  expect(Number.isSafeInteger(receipt.pid) && receipt.pid > 0 && facts?.pid === receipt.pid && isProcessAlive(receipt.pid), 'LIVE_RUNTIME_PID_REQUIRED')
  expect(typeof facts.instanceId === 'string' && facts.instanceId.length > 0 && /^[a-f0-9]{64}$/.test(facts.moduleHash) && facts.moduleHash === expectedModuleHash, 'LIVE_MODULE_HASH_REQUIRED')
  expect(Array.isArray(facts.config?.appliedSessionIds) && facts.limits && typeof facts.limits === 'object', 'LIVE_CONTEXT_FACTS_REQUIRED')
  if (stage.mode === 'apply') expect(facts.config.mode === 'apply' && facts.config.appliedSessionIds.includes(state.rootSessionId), 'NEW_SESSION_APPLY_GATE_REQUIRED')
  if (stage.mode === 'shadow') expect(facts.config.mode === 'shadow' || !facts.config.appliedSessionIds.includes(state.rootSessionId), 'NEW_SESSION_SHADOW_GATE_REQUIRED')
  expect(runtimeBinding, 'PTC_RUNTIME_BINDING_REQUIRED')
  expect(/^[a-f0-9]{64}$/.test(runtimeBinding.sdkSha256) && Number.isSafeInteger(runtimeBinding.schemaCount) && runtimeBinding.schemaCount > 0, 'FULL_SDK_CERTIFICATE_REQUIRED')
  const ptc = receipt.services?.ptc
  expect(ptc?.pid === receipt.pid && ptc.labSessionId === state.rootSessionId, 'LOADED_PTC_LAB_RECEIPT_REQUIRED')
  for (const key of ['language', 'agentPreset', 'runtimeKind', 'sdkSha256', 'schemaCount']) expect(ptc[key] === runtimeBinding[key], 'LIVE_PTC_BINDING_DRIFT_' + key.toUpperCase())
  expect(typeof runtimeBinding.toolsSchemaBindings?.context_manage === 'string' && ptc.toolsSchemaBindings?.context_manage === runtimeBinding.toolsSchemaBindings.context_manage, 'LIVE_PTC_TOOL_SCHEMA_DRIFT')
  expect(ptc.route?.provider === ROUTE.provider && ptc.route?.model === ROUTE.model && ptc.route.provider === runtimeBinding.route?.provider && ptc.route.model === runtimeBinding.route?.model, 'LIVE_PTC_ROUTE_DRIFT')
  return { source: receipt.source, capturedAt: receipt.capturedAt, pid: receipt.pid, labSessionId: receipt.labSessionId, instanceId: facts.instanceId, moduleHash: facts.moduleHash, mode: facts.config.mode, newSessionAllowlisted: facts.config.appliedSessionIds.includes(state.rootSessionId), ptc: clean(ptc) }
}

async function verifyMode(stage, state, callRpc, runtimeReceipt, runtimeBinding) {
  const file = runtimeReceipt ?? BASE + '/docs/architecture-review-20261001/runtime-services.json'
  expect(existsSync(file), 'LOADED_RUNTIME_RECEIPT_FILE_REQUIRED')
  const receipt = validateRuntimeReceipt(load(file), stage, state, { runtimeBinding, expectedModuleHash: hash(readFileSync(HOME + '/profiles/web/plugins/context-workspace.mjs')) })
  const described = await callRpc('settings/describe', {}), rows = described.namespaces ?? described
  const provider = rows.find(row => row.ns === 'llm-pi-ai')?.value?.providers?.opencodego
  expect(provider?.api === 'openai-completions' && provider.baseURL === 'http://127.0.0.1:8788/v1' && provider.models?.some(m => m.id === ROUTE.model), 'LIVE_PROVIDER_ROUTE_REQUIRED')
  return { ...receipt, receiptPath: file, receiptSha256: hash(readFileSync(file)), route: { provider: ROUTE.provider, model: ROUTE.model, baseURL: provider.baseURL, api: provider.api } }
}

export async function command(commandName, workspace, { run = false, stageId, callRpc = labRpc, runtimeReceipt } = {}) {
  workspace = labPath(workspace)
  if (commandName === 'prepare') return prepare(workspace)
  const plan = load(join(workspace, 'lab-plan.json')), fixture = load(join(workspace, 'fixture.json')), state = load(join(workspace, 'lab-state.json'))
  expect(pathEqual(plan.workspace, workspace) && pathEqual(state.workspace, workspace), 'STATE_WORKSPACE_DRIFT')
  const validation = validatePlan(plan, fixture, commandName === 'run')
  if (commandName === 'validate') return validation
  if (commandName === 'collect') return collect(plan, fixture, state)
  expect(run, 'EXPLICIT_RUN_SWITCH_REQUIRED')
  const lock = join(workspace, 'lab-run.lock'); let handle
  try {
    handle = openSync(lock, 'wx')
    if (commandName === 'create') {
      expect(!state.startedAt, 'CREATE_AFTER_MODEL_RUN_FORBIDDEN')
      if (state.created) return { phase: state.phase, rootSessionId: state.rootSessionId, workspaceId: state.workspaceId, modelRequests: 0, reused: true }
      const registered = await callRpc('workspace/create', { path: workspace })
      expect(pathEqual(registered.workspace.path, workspace), 'REGISTERED_WORKSPACE_DRIFT')
      state.workspaceId = registered.workspace.workspaceId; save(join(workspace, 'lab-state.json'), state)
      const created = await callRpc('session/create', { workspaceId: state.workspaceId, sessionId: state.rootSessionId, agentPreset: AGENT_PRESET })
      expect(created.sessionId === state.rootSessionId, 'CREATED_SESSION_ID_DRIFT')
      const selected = await callRpc('session/selectModel', { sessionId: state.rootSessionId, ...ROUTE })
      expect(selected.selected?.provider === ROUTE.provider && selected.selected?.model === ROUTE.model, 'SELECTED_MODEL_DRIFT')
      state.selected = { provider: selected.selected.provider, model: selected.selected.model, agentPreset: created.agentPreset ?? AGENT_PRESET }
      state.created = true; state.phase = 'created'; save(join(workspace, 'lab-state.json'), state)
      return { phase: state.phase, rootSessionId: state.rootSessionId, workspaceId: state.workspaceId, modelRequests: 0 }
    }
    expect(commandName === 'run' && state.created && state.phase !== 'stopped', 'RUN_STATE_REQUIRED')
    const stage = plan.stages.find(s => s.id === stageId); expect(stage, 'STAGE_REQUIRED')
    for (const priorStage of plan.stages.slice(0, plan.stages.indexOf(stage))) expect(state.stages[priorStage.id]?.status === 'completed', 'STAGE_ORDER_REQUIRED')
    const existing = state.stages[stage.id]
    if (existing?.status === 'completed') return { id: stage.id, status: 'already-completed' }
    expect(!existing, 'PROMPT_ALREADY_SUBMITTED_COLLECT_BEFORE_ANY_RETRY')
    const runtimeGate = await verifyMode(stage, state, callRpc, runtimeReceipt, plan.runtimeBinding)
    let snapshot = await readSnapshot(state)
    expect(snapshot.journals.some(j => j.header.id === state.rootSessionId), 'DURABLE_FRESH_ROOT_REQUIRED')
    const prior = await callRpc('session/list', {}), priorRoot = prior.items.find(s => s.sessionId === state.rootSessionId)
    expect(priorRoot?.running === false && snapshot.usage.active === 0, 'LAB_MUST_BE_IDLE')
    const deadline = state.startedAt ? Date.parse(state.startedAt) + LIMITS.durationMs : Date.now() + LIMITS.durationMs
    expect(!budgetStopReason(snapshot.usage, stage.reserve, deadline), 'CONSERVATIVE_PROMPT_RESERVE_EXHAUSTED')
    state.startedAt ??= new Date().toISOString()
    const renderedPrompt = stage.prompt.replaceAll('{{WORKSPACE}}', workspace.replaceAll('\\', '/')).replaceAll('{{ROOT_SESSION_ID}}', state.rootSessionId)
    const record = state.stages[stage.id] = { requestId: randomUUID(), status: 'submitting', submittedAt: new Date().toISOString(), baselineSeq: Math.max(...snapshot.journals.find(j => j.header.id === state.rootSessionId).rows.map(r => r.seq ?? -1)), templatePromptSha256: hash(stage.prompt), promptSha256: hash(renderedPrompt), baselineRequests: snapshot.usage.requests, runtimeGate }
    state.phase = 'running'; save(join(workspace, 'lab-state.json'), state)
    const receipt = await callRpc('session/prompt', { requestId: record.requestId, sessionId: state.rootSessionId, mode: 'queue', content: [{ type: 'text', text: renderedPrompt }], clientTimeZone: 'Asia/Shanghai' })
    expect(receipt.accepted === true, 'PROMPT_NOT_ACCEPTED'); record.status = 'accepted'; save(join(workspace, 'lab-state.json'), state)
    let idleReads = 0
    for (;;) {
      await pause(1000); snapshot = await readSnapshot(state)
      const reason = budgetStopReason(snapshot.usage, undefined, deadline)
      if (reason) { await cancelLab(state, snapshot, reason, callRpc); throw new Error(reason) }
      if (snapshot.rows.some(r => r.provider !== ROUTE.provider || r.model !== ROUTE.model)) { await cancelLab(state, snapshot, 'LEDGER_ROUTE_DRIFT', callRpc); throw new Error('LEDGER_ROUTE_DRIFT') }
      const failed = snapshot.rows.find(r => r.event === 'terminal' && r.status !== 'success')
      if (failed) { await cancelLab(state, snapshot, 'PROVIDER_TERMINAL_FAILURE', callRpc); throw new Error('PROVIDER_TERMINAL_FAILURE') }
      const live = await callRpc('session/list', {}), running = live.items.filter(s => snapshot.ids.has(s.sessionId)).some(s => s.running)
      const rootRows = snapshot.journals.find(j => j.header.id === state.rootSessionId)?.rows ?? []
      const terminal = rootRows.findLast(r => r.type === 'turn/end' && r.seq > record.baselineSeq)
      const failure = terminal && terminal.data.reason.kind !== 'completed'
      if (failure) { await cancelLab(state, snapshot, 'TURN_TERMINAL_FAILURE', callRpc); throw new Error('TURN_TERMINAL_FAILURE') }
      idleReads = !running && snapshot.usage.active === 0 && terminal ? idleReads + 1 : 0
      if (idleReads >= 2) break
    }
    record.status = 'completed'; record.completedAt = new Date().toISOString(); state.phase = 'idle'; save(join(workspace, 'lab-state.json'), state)
    const report = await collect(plan, fixture, state)
    expect(report.stages.find(s => s.id === stage.id)?.passed, 'STAGE_CANONICAL_VERIFICATION_FAILED')
    return { id: stage.id, status: record.status, evidencePassed: true, usage: report.usage }
  } catch (error) {
    if (state.phase === 'running' || (state.phase !== 'stopped' && commandName === 'run' && state.stages[stageId])) {
      const snapshot = await readSnapshot(state).catch(() => ({ ids: new Set([state.rootSessionId]) }))
      await cancelLab(state, snapshot, /^[A-Z_]+$/.test(error.message) ? error.message : 'LAB_RUNTIME_FAILURE', callRpc)
    }
    throw error
  } finally { if (handle !== undefined) { closeSync(handle); unlinkSync(lock) } }
}

export async function collect(plan, fixture, state) {
  const snapshot = await readSnapshot(state), sessions = [], stages = []
  for (const journal of snapshot.journals) {
    const ledger = snapshot.rows.filter(r => r.sessionId === journal.header.id && r.event === 'terminal')
    const assistant = journal.rows.filter(r => r.type === 'assistant/message' || r.type === 'assistant/attempt').map(row => {
      const matches = ledger.filter(r => Date.parse(r.startedAt) <= row.time && Date.parse(r.endedAt) >= row.time - 2000)
      return { seq: row.seq, turn: row.data.turn, step: row.data.step, event: row.type, usage: row.data.usage ?? null, ledgerRequestIds: matches.map(r => r.requestId), binding: matches.length === 1 ? 'unique-session-time-window' : 'unresolved' }
    })
    sessions.push({ sessionId: journal.header.id, parentSessionId: journal.header.parentSession ?? null, journalPath: journal.file, journalSha256: journal.sha256, inheritedBoundarySeq: journal.inheritedBoundarySeq,
      terminal: clean(journal.rows.findLast(r => r.type === 'turn/end')?.data ?? null), assistant, receipts: canonicalReceipts(journal.rows) })
  }
  for (const stage of plan.stages) {
    const record = state.stages[stage.id]; if (!record) continue
    const root = snapshot.journals.find(j => j.header.id === state.rootSessionId)
    const rows = root?.rows.filter(r => r.seq > record.baselineSeq && (!record.completedAt || r.time <= Date.parse(record.completedAt))) ?? []
    const receipts = snapshot.journals.flatMap(j => canonicalReceipts(j.rows.filter(r =>
      (j.header.id === state.rootSessionId ? r.seq > record.baselineSeq : r.time >= Date.parse(record.submittedAt)) && (!record.completedAt || r.time <= Date.parse(record.completedAt))))
      .map(r => ({ ...r, sessionId: j.header.id })))
    const assertions = checkReceipts(receipts, stage.receipts)
    const relations = checkReceiptRelations(receipts, stage.relations)
    const projectionChecks = (stage.projectionChecks ?? []).map(a => ({ transformId: a.transformId, status: a.status,
      passed: snapshot.rows.filter(r => r.event === 'terminal' && Date.parse(r.startedAt) >= Date.parse(record.submittedAt) && (!record.completedAt || Date.parse(r.endedAt) <= Date.parse(record.completedAt)) && (a.sessionId === undefined || r.sessionId === a.sessionId))
        .filter(r => r.requestProjection?.transforms?.some(t => t.id === a.transformId && t.status === a.status)).length >= (a.minCount ?? 1) }))
    const last = rows.findLast(r => r.type === 'assistant/message'), text = last?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    let answer; try { answer = JSON.parse(text) } catch { answer = null }
    const oracle = stage.checkOracle ? checkOracle(answer, fixture) : null
    const accepted = rows.some(r => r.type === 'user/message' && r.data.source?.rpcId === record.requestId)
    stages.push({ id: stage.id, requestId: record.requestId, status: record.status, runtimeGate: record.runtimeGate, acceptedUserMessage: accepted, assertions, relations, projectionChecks, oracle,
      passed: record.status === 'completed' && accepted && assertions.every(a => a.passed) && relations.every(a => a.passed) && projectionChecks.every(a => a.passed) && (!oracle || oracle.passed) })
  }
  const ledger = snapshot.rows.filter(r => r.event === 'terminal').map(r => ({ requestId: r.requestId, sessionId: r.sessionId, rootTeamId: r.rootTeamId, provider: r.provider, model: r.model, status: r.status, complete: r.complete, usage: r.usage, usageSource: r.usageSource,
    endpoint: r.endpoint, protocol: r.protocol, requestProjection: clean(r.requestProjection), startedAt: r.startedAt, endedAt: r.endedAt, ledgerFile: r.ledgerFile }))
  const report = { version: 1, workspace: state.workspace, rootSessionId: state.rootSessionId, phase: state.phase, fixtureSha256: fixture.sha256, usage: snapshot.usage,
    sessions, stages, ledger, wireHttpRequests: 'unknown; provider retries can exceed observable logical calls',
    evidenceComplete: stages.length > 0 && stages.length === plan.stages.length && snapshot.usage.unknown === 0 && !snapshot.usage.unknownFields && snapshot.usage.active === 0 && sessions.every(s => s.terminal?.reason?.kind === 'completed' && s.assistant.every(a => a.binding !== 'unresolved')) && stages.every(s => s.passed) }
  save(join(state.workspace, 'lab-evidence.json'), report)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [commandName, ...argv] = process.argv.slice(2), option = flag => argv[argv.indexOf(flag) + 1]
  try {
    expect(['prepare', 'validate', 'create', 'run', 'collect'].includes(commandName), 'COMMAND_REQUIRED')
    expect(argv.includes('--workspace'), 'WORKSPACE_REQUIRED')
    const result = await command(commandName, option('--workspace'), { run: argv.includes('--run'), stageId: argv.includes('--stage') ? option('--stage') : undefined, runtimeReceipt: argv.includes('--runtimeReceipt') ? option('--runtimeReceipt') : undefined })
    console.log(JSON.stringify(commandName === 'collect' ? { phase: result.phase, evidenceComplete: result.evidenceComplete, usage: result.usage, stages: result.stages, output: join(result.workspace, 'lab-evidence.json') } : result))
  } catch (error) { console.error(JSON.stringify({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'LAB_COMMAND_FAILED' })); process.exitCode = 1 }
}
