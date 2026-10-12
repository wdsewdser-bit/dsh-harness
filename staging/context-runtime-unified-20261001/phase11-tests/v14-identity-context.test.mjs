import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveIdentity } from '../home/profiles/web/plugins/team-v14-identity.mjs'
import { actionFingerprint } from '../home/profiles/web/plugins/team-v13-failure-memory.mjs'
import { apply as applyContinuation } from '../home/profiles/web/plugins/team-v14-event-continuation.mjs'
import { buildContextDelivery, durableContextVersions, identitySource, taskContext } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'
import { contextRequirementSnapshot, requirementSnapshot } from '../home/profiles/web/plugins/team-v14-requirements.mjs'
import { createRegistry } from '../home/profiles/web/plugins/team-policy.mjs'

// Cordis Context objects are proxies that throw for undeclared property reads.
// Reading ctx.sessionId off one used to abort every tool call through the
// failure-memory pre-execute hook.
function cordisLike(seed = {}) {
  return new Proxy(seed, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

test('resolveIdentity tolerates a throwing cordis context', () => {
  const identity = resolveIdentity({ name: 'bash', callId: 'call-1', agent: { session: { id: 'sess-1' } } }, cordisLike(), {})
  assert.equal(identity.sessionId, 'sess-1')
})

test('resolveIdentity never throws when every source is a throwing proxy', () => {
  const proxy = cordisLike()
  const identity = resolveIdentity(proxy, proxy, {})
  assert.equal(typeof identity.sessionId, 'string')
  assert.ok(identity.sessionId.length > 0)
})

test('resolveIdentity keeps a stable fallback id for the same agent object', () => {
  const agent = cordisLike()
  const first = resolveIdentity({ name: 'bash', agent }, cordisLike(), {})
  const second = resolveIdentity({ name: 'bash', agent }, cordisLike(), {})
  assert.equal(first.sessionId, second.sessionId)
})

test('resolveIdentity still reads plain identity fields', () => {
  const identity = resolveIdentity({ name: 'bash' }, { sessionId: 'sess-ctx', teamId: 'team-ctx' }, {})
  assert.equal(identity.sessionId, 'sess-ctx')
  assert.equal(identity.teamId, 'team-ctx')
})

test('web and headless identity modules stay byte-identical', () => {
  const web = readFileSync(new URL('../home/profiles/web/plugins/team-v14-identity.mjs', import.meta.url))
  const headless = readFileSync(new URL('../home/profiles/headless/plugins/team-v14-identity.mjs', import.meta.url))
  assert.equal(web.equals(headless), true)
})

test('failure-memory fingerprints tolerate a throwing cordis identity context', () => {
  const exec = { name: 'bash', arguments: { command: 'build' }, agent: { session: { id: 's1' } } }
  const fingerprint = actionFingerprint(exec, { identity: cordisLike() })
  assert.equal(typeof fingerprint, 'string')
  assert.equal(fingerprint.length, 64)
  assert.equal(actionFingerprint(exec, { identity: cordisLike() }), fingerprint)
})

test('continuation scan never throws from an inactive plugin context', () => {
  const savedSetInterval = globalThis.setInterval
  let tick
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} } }
  try {
    let active = true
    const inactive = () => { throw new Error('cannot get required service "agents" in inactive context') }
    const ctx = {
      on: () => () => {},
      logger: { warn: () => { throw new Error('inactive logger') } },
      agentTeams: { tryMembership: inactive, listMembers: inactive, sendMessage: inactive },
      get agents() { return active ? { list: () => [] } : inactive() },
    }
    const dispose = applyContinuation(ctx, { scanMs: 10 })
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => tick())
    active = false
    assert.doesNotThrow(() => tick())
    assert.doesNotThrow(() => dispose())
  } finally {
    globalThis.setInterval = savedSetInterval
  }
})

test('old members receive only the changed role identity on their next context turn', () => {
  const roles = mkdtempSync(join(tmpdir(), 'v14-identity-delta-'))
  try {
    const agents = '# Team agents\nbase rules\n'
    const member = '# Member role\nbase member role\n'
    writeFileSync(join(roles, 'AGENTS.md'), agents)
    writeFileSync(join(roles, 'member.md'), member)
    const hash = (value) => createHashForTest(value)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({
      identityVersion: 'v14-test.1',
      files: { 'AGENTS.md': hash(agents), 'member.md': hash(member) },
    }))
    const mine = { name: 'member-a', tier: 2, role: 'member', group: 'group-a' }
    const firstSource = identitySource(roles, mine)
    const first = buildContextDelivery({
      sources: [firstSource],
      visible: [],
      member: mine.name,
      sessionId: 'session-a',
      maxTokens: 4000,
    })
    assert.match(first.body, /v14-test\.1/)
    const visible = [{
      source: { kind: 'team-message', plugin: 'team-v12-runtime' },
      content: [{ type: 'text', text: first.body }],
    }]
    const unchanged = buildContextDelivery({
      sources: [identitySource(roles, mine)],
      visible,
      member: mine.name,
      sessionId: 'session-a',
      maxTokens: 4000,
    })
    assert.equal(unchanged.body, '')

    const changedMember = '# Member role\nchanged member role\n'
    writeFileSync(join(roles, 'member.md'), changedMember)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({
      identityVersion: 'v14-test.2',
      files: { 'AGENTS.md': hash(agents), 'member.md': hash(changedMember) },
    }))
    const changed = buildContextDelivery({
      sources: [identitySource(roles, mine)],
      visible,
      member: mine.name,
      sessionId: 'session-a',
      maxTokens: 4000,
    })
    assert.match(changed.body, /v14-test\.2/)
    assert.match(changed.body, /changed member role/)
  } finally {
    rmSync(roles, { recursive: true, force: true })
  }
})

test('tier 0 receives root.md while tier 1 receives lead.md', () => {
  const roles = mkdtempSync(join(tmpdir(), 'v14-root-identity-'))
  try {
    const agents = '# Team agents\nbase rules\n'
    const root = '# Root role\nroot operational identity\n'
    const lead = '# Lead role\ntier 1 group lead identity\n'
    writeFileSync(join(roles, 'AGENTS.md'), agents)
    writeFileSync(join(roles, 'root.md'), root)
    writeFileSync(join(roles, 'lead.md'), lead)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({
      identityVersion: 'v14-root-test.1',
      files: {
        'AGENTS.md': createHashForTest(agents),
        'root.md': createHashForTest(root),
        'lead.md': createHashForTest(lead),
      },
    }))
    const rootSource = identitySource(roles, { name: 'lead', tier: 0, role: 'lead' })
    const leadSource = identitySource(roles, { name: 'lead-a', tier: 1, role: 'lead' })
    assert.equal(rootSource.metadata.roleFile, 'root.md')
    assert.match(rootSource.content, /root operational identity/)
    assert.doesNotMatch(rootSource.content, /tier 1 group lead identity/)
    assert.equal(leadSource.metadata.roleFile, 'lead.md')
    assert.match(leadSource.content, /tier 1 group lead identity/)
  } finally {
    rmSync(roles, { recursive: true, force: true })
  }
})

test('durable delivery receipts suppress a source after visible history is gone', () => {
  const source = {
    id: 'requirement:req-durable',
    revision: 3,
    required: true,
    content: 'durable requirement body',
  }
  const first = buildContextDelivery({
    sources: [source],
    visible: [],
    member: 'member-a',
    sessionId: 'session-a',
    maxTokens: 4000,
  })
  const receipts = [{ member: 'member-a', sessionId: 'session-a', items: first.manifest.items,
    dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'request-1' } }]
  const versions = durableContextVersions(receipts, { member: 'member-a', sessionId: 'session-a' })
  assert.equal(versions.get(source.id), first.manifest.items[0].hash)
  const repeat = buildContextDelivery({
    sources: [source],
    visible: [],
    acknowledged: receipts,
    member: 'member-a',
    sessionId: 'session-a',
    maxTokens: 4000,
  })
  assert.equal(repeat.body, '')
})

test('context requirement snapshots avoid full-ledger history cloning without changing active rows', () => {
  const ledger = {
    version: 1,
    revision: 7,
    requirements: {
      active: {
        requirementId: 'active',
        text: 'active requirement',
        status: 'active',
        taskIds: ['task-1'],
        history: [{ text: 'old version' }],
        revision: 2,
      },
      superseded: {
        requirementId: 'superseded',
        text: 'superseded requirement',
        status: 'superseded',
        history: [{ text: 'old version' }],
        revision: 1,
      },
    },
    decisions: {
      confirmed: {
        decisionId: 'confirmed',
        choice: 'confirmed decision',
        status: 'confirmed',
        taskIds: ['task-1'],
        history: [{ choice: 'old choice' }],
        revision: 3,
      },
      proposed: {
        decisionId: 'proposed',
        choice: 'proposed decision',
        status: 'proposed',
        revision: 1,
      },
    },
    events: [{ revision: 7, requirementId: 'active' }],
  }
  const full = requirementSnapshot(ledger)
  const compact = contextRequirementSnapshot(ledger)
  const stripHistory = (row) => {
    const { history, ...rest } = row
    return rest
  }
  assert.deepEqual(compact.requirements, full.requirements.map(stripHistory))
  assert.deepEqual(compact.decisions, full.decisions.map(stripHistory))
  assert.equal(compact.revision, full.revision)
  assert.equal(compact.requirements[0].history, undefined)
})

test('required context debt is visible, fetchable, and fails closed for safety-critical sources', () => {
  const required = {
    id: 'task:contract-1',
    revision: 1,
    required: true,
    safetyCritical: true,
    content: 'required contract '.repeat(200),
    fetch: { action: 'task_contract_get', task_id: 'contract-1' },
  }
  const optional = {
    id: 'room:optional',
    revision: 1,
    required: false,
    priority: 0,
    content: 'optional room context',
  }
  const delivery = buildContextDelivery({
    sources: [optional, required],
    visible: [],
    member: 'member-a',
    sessionId: 'session-a',
    maxTokens: 80,
  })
  assert.equal(delivery.debt, true)
  assert.equal(delivery.failClosed, true)
  assert.match(delivery.body, /context-debt/)
  assert.match(delivery.body, /task_contract_get/)
  assert.doesNotMatch(delivery.body, /optional room context/)
})

test('large task deliverables are bounded without removing the full-contract fetch path', () => {
  const original = 'world handoff '.repeat(9000)
  const context = taskContext({
    id: 'group-world-t139',
    revision: 36,
    ownerName: 'lead-world-3',
    status: 'blocked',
    phase: 'execution',
    subject: 'large world handoff',
    contract: {
      deliverable: original,
      acceptanceCriteria: ['preserve full contract fetch'],
      writeScopes: ['crates/mc-world'],
    },
  })
  assert.equal(context.deliverableTruncated, true)
  assert.equal(context.deliverableChars, original.length)
  assert.equal(context.deliverableDigest.length, 16)
  assert.ok(context.deliverable.length <= 4096)
  assert.match(context.deliverable, /task deliverable truncated/)
  assert.deepEqual(context.fetch, { action: 'task_contract_get', task_id: 'group-world-t139' })

  const delivery = buildContextDelivery({
    sources: [{
      id: 'task:group-world-t139',
      revision: 36,
      required: true,
      safetyCritical: true,
      content: JSON.stringify(context),
      metadata: { fetch: context.fetch },
    }],
    visible: [],
    member: 'lead-world-3',
    sessionId: 'session-world-3',
    maxTokens: 12000,
  })
  assert.equal(delivery.debt, false)
  assert.equal(delivery.failClosed, false)
  assert.match(delivery.body, /task_contract_get/)
  assert.match(delivery.body, /task deliverable truncated/)
})

test('policy header and registry defaults agree on 8/8/30', () => {
  const registry = createRegistry()
  assert.equal(registry.maxTier1Leads, 8)
  assert.equal(registry.maxMembersPerLead, 8)
  assert.equal(registry.maxMembers, 30)
  const header = readFileSync(new URL('../home/profiles/web/plugins/team-policy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(header, /cap of 13 TEAMMATES/)
  assert.match(header, /8 tier-1 leads/)
  assert.match(header, /30 active non-frozen members/)
})

function createHashForTest(value) {
  return createHash('sha256').update(value).digest('hex')
}
