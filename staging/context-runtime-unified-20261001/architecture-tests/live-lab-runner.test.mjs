import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { command, makeFixture, checkOracle, labPath, validatePlan, measureBudget, budgetStopReason, canonicalReceipts, checkReceipts, checkReceiptRelations, verifyLabLineage, workspaceJournalDirectory, ownJournalRows, validateRuntimeReceipt, wireArguments, RPC_ARGUMENT_NAMES, LIMITS, ROUTE } from '../tools/clm-live-session-lab.mjs'

test('workspace boundary rejects original workspace and traversal', () => {
  assert.throws(() => labPath('D:/dsh-test/workspaces/RustMc'), /LAB_WORKSPACE_BOUNDARY/)
  assert.throws(() => labPath('D:/dsh-test/workspaces/clm-lab-20261001-a/../test'), /LAB_WORKSPACE_BOUNDARY/)
  assert.throws(() => labPath('D:/dsh-test/workspaces/clm-lab-20261001-a/nested'), /LAB_WORKSPACE_BOUNDARY/)
  assert.match(workspaceJournalDirectory('D:\\dsh-test\\workspaces\\clm-lab-20261001-test'), /--D-dsh-test-workspaces-clm-lab-20261001-test--$/)
})

test('fixture oracle requires exact original line text and checksums', () => {
  const fixture = makeFixture()
  assert.equal(checkOracle(fixture.oracle, fixture).passed, true)
  assert.equal(checkOracle({ ...fixture.oracle, error_line: 172 }, fixture).passed, false)
  assert.equal(checkOracle({ ...fixture.oracle, quotes: fixture.oracle.quotes.map(q => ({ ...q, text: q.text + '.' })) }, fixture).passed, false)
})

test('prepare and validate never call RPC; create requires explicit --run', async () => {
  const workspace = 'D:/dsh-test/workspaces/clm-lab-20261001-offline-' + randomUUID()
  let requests = 0
  const callRpc = async () => { requests++; throw new Error('UNEXPECTED_RPC') }
  try {
    const prepared = await command('prepare', workspace, { callRpc })
    assert.equal(prepared.modelRequests, 0)
    assert.equal((await command('validate', workspace, { callRpc })).ready, false)
    await assert.rejects(command('create', workspace, { callRpc }), /EXPLICIT_RUN_SWITCH_REQUIRED/)
    await assert.rejects(command('run', workspace, { run: true, stageId: 'anything', callRpc }), /FINAL_SCHEMA_AND_STAGES_REQUIRED/)
    const plan = JSON.parse(readFileSync(workspace + '/lab-plan.json', 'utf8'))
    const fixture = JSON.parse(readFileSync(workspace + '/fixture.json', 'utf8'))
    assert.throws(() => validatePlan({ ...plan, route: { ...plan.route, model: 'other' } }, fixture), /ROUTE_DRIFT/)
    assert.equal(requests, 0)
  } finally { rmSync(labPath(workspace), { recursive: true }) }
})

test('budget combines cached prompt counters and stops unknown usage', () => {
  const usage = measureBudget([{ event: 'start', requestId: 'r1' }, { event: 'terminal', requestId: 'r1', usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 9 } }])
  assert.deepEqual(usage, { requests: 1, inputTokens: 33, outputTokens: 9, unknown: 0, active: 0 })
  assert.equal(budgetStopReason({ ...usage, requests: 16 }), 'BUDGET_requests')
  assert.equal(budgetStopReason(usage, { requests: 15, inputTokens: 1, outputTokens: 1 }), 'BUDGET_requests')
  assert.equal(budgetStopReason({ ...usage, unknown: 1 }), 'UNKNOWN_USAGE_STOP')
  assert.equal(budgetStopReason({ ...usage, active: 2 }), 'CONCURRENCY_LIMIT')
  assert.equal(budgetStopReason(usage, undefined, 100, 101), 'DURATION_LIMIT')
  assert.throws(() => measureBudget([{ event: 'terminal', requestId: 'dup' }, { event: 'terminal', requestId: 'dup' }]), /DUPLICATE_LEDGER_EVENT/)
  assert.equal(LIMITS.durationMs, 600000)
})

test('lineage approves only fresh lab root and one direct child', () => {
  const workspace = labPath('D:/dsh-test/workspaces/clm-lab-20261001-test'), state = { rootSessionId: 'session-lab', workspace }
  const root = { header: { id: state.rootSessionId, cwd: workspace, isSeeded: false } }
  const child = { header: { id: 'session-child', cwd: workspace, parentSession: state.rootSessionId, origin: 'subagent', delegationDepth: 1 } }
  assert.equal(verifyLabLineage([root, child], state).length, 2)
  assert.throws(() => verifyLabLineage([root, { header: { ...child.header, parentSession: 'session-original' } }], state), /LAB_LINEAGE_BOUNDARY/)
  assert.throws(() => verifyLabLineage([{ header: { ...root.header, isSeeded: true } }], state), /FRESH_ROOT_REQUIRED/)
  assert.throws(() => verifyLabLineage([root, child, { header: { ...child.header, id: 'session-child2' } }], state), /DESCENDANT_LIMIT/)
})

test('canonical tool pairs validate structured receipt, never model success claims', () => {
  const rows = [
    { type: 'tool/call', seq: 10, data: { callId: 'c1', name: 'context_manage', arguments: '{"action":"memo_put","input":{"text":"fixture"}}' } },
    { type: 'tool/result', seq: 11, data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"ok":true,"revision":1,"apiKey":"hidden"}' }] } } },
    { type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'text', text: 'success' }] } } },
  ]
  const receipts = canonicalReceipts(rows)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].values[0].apiKey, undefined)
  assert.equal(checkReceipts(receipts, [{ tool: 'context_manage', action: 'memo_put', pointer: '/values/0/revision', equals: 1 }])[0].passed, true)
  assert.equal(checkReceipts(receipts, [{ tool: 'context_manage', pointer: '/values/0/revision', equals: 2 }])[0].passed, false)
  assert.throws(() => canonicalReceipts(rows.slice(1)), /UNPAIRED_TOOL_RESULT/)
})

test('canonical PTC child receipt preserves real subCallId and structured denial', () => {
  const rows = [
    { type: 'tool/ptc-dispatch-start', seq: 14, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:ptc:1', name: 'context_manage', arguments: { action: 'memo_get' } } },
    { type: 'tool/ptc-dispatch', seq: 15, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:ptc:1', name: 'context_manage', arguments: { action: 'memo_get' }, isError: false, content: [{ type: 'text', text: '{"ok":false,"code":"MEMBER_SCOPE_DENIED"}' }] } },
  ]
  const receipt = canonicalReceipts(rows)[0]
  assert.equal(receipt.kind, 'canonical-ptc-subcall')
  assert.equal(receipt.callId, 'outer:ptc:1')
  assert.equal(checkReceipts([receipt], [{ tool: 'context_manage', action: 'memo_get', pointer: '/values/0/code', equals: 'MEMBER_SCOPE_DENIED' }])[0].passed, true)
  assert.throws(() => canonicalReceipts(rows.slice(1)), /UNPAIRED_PTC_DISPATCH/)
})

test('seeded child excludes inherited receipts and usage from ancestor prefix', () => {
  const rows = [{ type: 'assistant/message', seq: 0 }, { type: 'session/end-seed', seq: 1, data: { inherited: true } },
    { type: 'assistant/message', seq: 2 }, { type: 'session/end-seed', seq: 3, data: { inherited: true } }, { type: 'assistant/message', seq: 4 }]
  const owned = ownJournalRows(rows, { isSeeded: true })
  assert.equal(owned.inheritedBoundarySeq, 3)
  assert.deepEqual(owned.rows.map(r => r.seq), [4])
  assert.throws(() => ownJournalRows([{ type: 'assistant/message', seq: 0 }], { isSeeded: true }), /SEEDED_CHILD_CUT_REQUIRED/)
})

test('runtime gate requires fresh live PID exact lab ID and loaded module hash', () => {
  const now = Date.now(), moduleHash = 'a'.repeat(64), state = { rootSessionId: 'session-lab' }
  const receipt = { source: 'loaded-runtime-services', capturedAt: new Date(now).toISOString(), pid: process.pid, labSessionId: state.rootSessionId,
    services: { contextWorkspace: { pid: process.pid, instanceId: 'instance-test', moduleHash, config: { mode: 'apply', appliedSessionIds: [state.rootSessionId] }, limits: { inputBytes: 32768 } } } }
  const opts = { now, expectedModuleHash: moduleHash }
  const runtimeBinding = { language: 'typescript', agentPreset: 'ptc', runtimeKind: 'dsh-ptc-runtime-node', sdkSha256: 'c'.repeat(64), schemaCount: 40, toolsSchemaBindings: { context_manage: 'd'.repeat(64) }, route: ROUTE }
  opts.runtimeBinding = runtimeBinding
  receipt.services.ptc = { ...runtimeBinding, pid: process.pid, labSessionId: state.rootSessionId }
  assert.equal(validateRuntimeReceipt(receipt, { mode: 'apply' }, state, opts).newSessionAllowlisted, true)
  assert.throws(() => validateRuntimeReceipt({ ...receipt, source: 'disk-config' }, { mode: 'apply' }, state, opts), /LOADED_RUNTIME_LAB_RECEIPT_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt({ ...receipt, labSessionId: 'session-original' }, { mode: 'apply' }, state, opts), /LOADED_RUNTIME_LAB_RECEIPT_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt(receipt, { mode: 'apply' }, state, { ...opts, now: now + 61000 }), /FRESH_RUNTIME_RECEIPT_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt(receipt, { mode: 'apply' }, state, { ...opts, isProcessAlive: () => false }), /LIVE_RUNTIME_PID_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt(receipt, { mode: 'apply' }, state, { ...opts, expectedModuleHash: 'b'.repeat(64) }), /LIVE_MODULE_HASH_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt(receipt, { mode: 'shadow' }, state, opts), /NEW_SESSION_SHADOW_GATE_REQUIRED/)
  assert.throws(() => validateRuntimeReceipt({ ...receipt, services: { contextWorkspace: receipt.services.contextWorkspace } }, { mode: 'apply' }, state, opts), /LOADED_PTC_LAB_RECEIPT_REQUIRED/)
  for (const [key, value] of [['labSessionId', 'foreign'], ['pid', process.pid + 1], ['language', 'python'], ['sdkSha256', 'e'.repeat(64)], ['schemaCount', 41], ['runtimeKind', 'other'], ['agentPreset', 'other'], ['toolsSchemaBindings', { context_manage: 'f'.repeat(64) }], ['route', { ...ROUTE, model: 'other' }]]) {
    assert.throws(() => validateRuntimeReceipt({ ...receipt, services: { ...receipt.services, ptc: { ...receipt.services.ptc, [key]: value } } }, { mode: 'apply' }, state, opts), /LOADED_PTC_LAB_RECEIPT_REQUIRED|LIVE_PTC_/)
  }
  assert.throws(() => validateRuntimeReceipt(receipt, { mode: 'apply' }, state, { ...opts, runtimeBinding: { ...runtimeBinding, sdkSha256: null, schemaCount: null } }), /FULL_SDK_CERTIFICATE_REQUIRED/)
})

test('logical RPC adapter matches every installed rc2 gateway descriptor parameter', async () => {
  const descriptors = []
  for (const name of ['dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-api-settings-controller']) {
    const { TYPERT } = await import('file:///D:/dsh-test/app/node_modules/@deepseek-ai/' + name + '/lib/typert.host.js')
    descriptors.push(...TYPERT.invocations)
  }
  for (const [method, parameterName] of Object.entries(RPC_ARGUMENT_NAMES)) {
    const descriptor = descriptors.find(d => d.namespace + '/' + d.method === method)
    assert.ok(descriptor, method)
    assert.deepEqual(descriptor.parameters.map(p => p.name), parameterName === null ? [] : [parameterName], method)
    const args = method === 'settings/describe' ? {} : { fixture: 'bounded' }
    assert.deepEqual(wireArguments(method, args), parameterName === null ? {} : { [parameterName]: args }, method)
  }
  assert.deepEqual(wireArguments('workspace/create', { path: 'lab' }), { request: { path: 'lab' } })
  assert.deepEqual(wireArguments('session/list'), { _request: {} })
  assert.throws(() => wireArguments('settings/describe', { ns: 'context-workspace' }), /RPC_NO_ARGUMENTS_REQUIRED/)
  assert.throws(() => wireArguments('settings/mutate', {}), /LAB_RPC_METHOD_NOT_ALLOWED/)
})

test('stage template is offline, syntactically executable, bounded, and schema-bound', async () => {
  const template = JSON.parse(readFileSync(new URL('../docs/context-runtime-unified-20261001/live-lab-stage-template.json', import.meta.url), 'utf8'))
  const workspace = 'D:/dsh-test/workspaces/clm-lab-20261001-template-' + randomUUID()
  try {
    await command('prepare', workspace)
    const plan = JSON.parse(readFileSync(workspace + '/lab-plan.json', 'utf8')), fixture = JSON.parse(readFileSync(workspace + '/fixture.json', 'utf8'))
    const bound = { ...plan, stages: template.stages, schemaFiles: template.schemaFiles, runtimeBinding: template.runtimeBinding, pending: [] }
    assert.equal(validatePlan(bound, fixture, true).valid, true)
    assert.equal(template.schemaBinding.kind, 'lab-tool-subset')
    assert.equal(template.runtimeBinding.sdkSha256, null)
    assert.equal(template.runtimeBinding.schemaCount, null)
    assert.throws(() => validatePlan({ ...bound, runtimeBinding: undefined }, fixture, true), /PTC_RUNTIME_BINDING_REQUIRED/)
    assert.throws(() => validatePlan({ ...bound, runtimeBinding: { ...bound.runtimeBinding, language: 'python' } }, fixture, true), /PTC_RUNTIME_BINDING_REQUIRED/)
    assert.throws(() => validatePlan({ ...bound, schemaFiles: bound.schemaFiles.map((s, i) => i === 0 ? { ...s, sha256: '0'.repeat(64) } : s) }, fixture, true), /SCHEMA_DRIFT/)
    const old = JSON.parse(readFileSync('D:/dsh-test/docs/architecture-review-20261001/live-lab-stage-template.json', 'utf8'))
    assert.throws(() => validatePlan({ ...bound, schemaFiles: old.schemaFiles }, fixture, true), /SCHEMA_DRIFT|PTC_SCHEMA_BINDING_REQUIRED/)
    assert.equal(template.stages.length, 3)
    assert.equal(/session-[a-f0-9]{8}-[a-f0-9-]{20}/i.test(JSON.stringify(template)), false)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    for (const stage of template.stages) assert.equal(typeof new AsyncFunction('tools', stage.runCode.code), 'function')
  } finally { rmSync(labPath(workspace), { recursive: true }) }
})

test('one wait and one roster verification stop before info when child is still active', async () => {
  const template = JSON.parse(readFileSync(new URL('../docs/context-runtime-unified-20261001/live-lab-stage-template.json', import.meta.url), 'utf8'))
  const code = template.stages.find(s => s.id === 'apply-child-operation').runCode.code
  const calls = []
  const tools = {
    context_manage: async () => ({ ok: true, mode: 'apply-allowlisted', viewRevision: 1 }),
    spawn_teammate: async () => { calls.push('spawn'); return { member: { name: 'clm-scope-verifier' } } },
    wait_agent: async () => { calls.push('wait'); return { timedOut: false } },
    list_agents: async () => { calls.push('roster'); return [{ name: 'clm-scope-verifier', status: 'running' }] },
    send_message: async () => { calls.push('message'); throw new Error('MUST_NOT_SEND') },
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await assert.rejects(new AsyncFunction('tools', code)(tools), /LAB_CHILD_NOT_TERMINAL/)
  assert.deepEqual(calls, ['spawn', 'wait', 'roster'])
})

test('canonical receipt relationships reject changed message identity and task revision', () => {
  const receipts = [{ tool: 'send_message', values: [{ duplicate: false, messageId: 'm1' }] }, { tool: 'send_message', values: [{ duplicate: true, messageId: 'm1' }] }]
  const relation = { name: 'same-message', left: { tool: 'send_message', pointer: '/values/0/messageId', where: { pointer: '/values/0/duplicate', equals: false } }, right: { tool: 'send_message', pointer: '/values/0/messageId', where: { pointer: '/values/0/duplicate', equals: true } } }
  assert.equal(checkReceiptRelations(receipts, [relation])[0].passed, true)
  receipts[1].values[0].messageId = 'm2'
  assert.equal(checkReceiptRelations(receipts, [relation])[0].passed, false)
  assert.equal(checkReceiptRelations([], [relation])[0].passed, false)
  const tasks = [{ tool: 'team_task_get', values: [{ revision: 3 }] }, { tool: 'team_task_get', values: [{ revision: 4 }] }]
  assert.equal(checkReceiptRelations(tasks, [{ name: 'unchanged-revision', left: { tool: 'team_task_get', pointer: '/values/0/revision', pick: 'first' }, right: { tool: 'team_task_get', pointer: '/values/0/revision', pick: 'last' } }])[0].passed, false)
})

test('run rejects missing or unknown full SDK certificate before any RPC', async () => {
  const template = JSON.parse(readFileSync(new URL('../docs/context-runtime-unified-20261001/live-lab-stage-template.json', import.meta.url), 'utf8'))
  const workspace = 'D:/dsh-test/workspaces/clm-lab-20261001-gate-' + randomUUID()
  let rpcCalls = 0
  const callRpc = async () => { rpcCalls++; throw new Error('UNEXPECTED_RPC') }
  try {
    await command('prepare', workspace, { callRpc })
    const plan = JSON.parse(readFileSync(workspace + '/lab-plan.json', 'utf8'))
    writeFileSync(workspace + '/lab-plan.json', JSON.stringify({ ...plan, stages: template.stages, schemaFiles: template.schemaFiles, runtimeBinding: template.runtimeBinding, pending: [] }))
    const state = JSON.parse(readFileSync(workspace + '/lab-state.json', 'utf8'))
    writeFileSync(workspace + '/lab-state.json', JSON.stringify({ ...state, created: true }))
    const opts = { run: true, stageId: template.stages[0].id, callRpc, runtimeReceipt: workspace + '/runtime.json' }
    await assert.rejects(command('run', workspace, opts), /LOADED_RUNTIME_RECEIPT_FILE_REQUIRED/)
    // Synthetic offline fixture: process liveness does not establish server provenance.
    const receipt = { source: 'loaded-runtime-services', capturedAt: new Date().toISOString(), pid: process.pid, labSessionId: state.rootSessionId,
      services: { contextWorkspace: { pid: process.pid, instanceId: 'offline-fixture', moduleHash: createHash('sha256').update(readFileSync('D:/dsh-test/home/profiles/web/plugins/context-workspace.mjs')).digest('hex'), config: { mode: 'shadow', appliedSessionIds: [] }, limits: {} }, ptc: { ...template.runtimeBinding, pid: process.pid, labSessionId: state.rootSessionId } } }
    writeFileSync(opts.runtimeReceipt, JSON.stringify(receipt))
    await assert.rejects(command('run', workspace, opts), /FULL_SDK_CERTIFICATE_REQUIRED/)
    assert.equal(rpcCalls, 0)
  } finally { rmSync(labPath(workspace), { recursive: true }) }
})
