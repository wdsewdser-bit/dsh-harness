import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createActiveIdentityService } from '../home/profiles/web/plugins/team-v15-active-identity.mjs'
import { buildContextDelivery } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const rolesDir = fileURLToPath(new URL('../home/team-roles/', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(join(rolesDir, 'identity-version.json'), 'utf8'))
const digest = body => createHash('sha256').update(body).digest('hex')
const actors = {
  root: { name: 'root', id: 'root-id', tier: 0 },
  lead: { name: 'lead-a', id: 'lead-id', tier: 1 },
  member: { name: 'member-a', id: 'member-id', tier: 2 },
  verifier: { name: 'verifier', id: 'verifier-id', role: 'verifier', tier: 1 },
}

test('shipped scheduling identities hash-check, activate, and reach every role next-turn context', async t => {
  const temporary = fs.mkdtempSync(join(tmpdir(), 'scheduling-identities-'))
  const cp = controlPlaneFor('scheduling-' + randomUUID(), { directory: temporary })
  t.after(() => { resetControlPlaneCache(); fs.rmSync(temporary, { recursive: true, force: true }) })
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(digest(fs.readFileSync(join(rolesDir, file))), hash.toLowerCase(), file)
  }
  const service = createActiveIdentityService({ controlPlane: cp, rolesDir,
    allowedRoots: [resolve(rolesDir, '..')], resolveActor: context => actors[context?.principal] })
  await cp.mutateHot('test/seed', {}, null, state => { state.testSeed = true }, { deferMs: 0 })
  const proposal = service.readonly.proposal()
  const state = cp.snapshot({ history: false, copy: true })
  await service.internal.activate({ expectedControlRevision: state.revision,
    expectedIdentityEpoch: state.identityEpoch ?? 0, expectedBundleHash: proposal.contentHash }, { principal: 'root' })
  const common = fs.readFileSync(join(rolesDir, 'AGENTS.md'), 'utf8')
  for (const role of Object.keys(actors)) {
    const source = service.readonly.identitySource({ principal: role })
    const body = fs.readFileSync(join(rolesDir, role + '.md'), 'utf8')
    assert.equal(source.metadata.roleFile, role + '.md')
    assert.ok(source.content.includes(common), role + ' must consume the full shared guidance')
    assert.ok(source.content.includes(body), role + ' must consume its full role guidance')
    const delivery = buildContextDelivery({ sources: [source], visible: [], member: actors[role].name,
      sessionId: role + '-session', maxTokens: 24000 })
    assert.equal(delivery.failClosed, false)
    assert.ok(delivery.body.includes(common), role + ' shared text reaches the actual turn')
    assert.ok(delivery.body.includes(body), role + ' role text reaches the actual turn')
    const visible = [{ source: { kind: 'team-message', plugin: 'team-v12-runtime' },
      content: [{ type: 'text', text: delivery.body }] }]
    assert.equal(buildContextDelivery({ sources: [source], visible, member: actors[role].name,
      sessionId: role + '-session', maxTokens: 24000 }).body, '', role + ' does not duplicate delivery')
  }
})
