import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

test('member routes are durable, replaceable, and survive a control-plane restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-member-route-'))
  try {
    const rootId = 'member-route-team'
    const cp = controlPlaneFor(rootId, { directory: dir })
    await cp.memberRouteSet({
      member: 'lead',
      route: {
        provider: 'opencodego',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'max',
      },
      updatedBy: 'lead',
    }, { name: 'lead', tier: 0 })

    const persisted = JSON.parse(readFileSync(join(dir, rootId + '.json'), 'utf8'))
    assert.deepEqual(persisted.memberRoutes.lead, {
      member: 'lead',
      provider: 'opencodego',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'max',
      updatedAt: persisted.memberRoutes.lead.updatedAt,
      updatedBy: 'lead',
    })

    resetControlPlaneCache()
    const reopened = controlPlaneFor(rootId, { directory: dir })
    assert.deepEqual(reopened.memberRoute('lead'), persisted.memberRoutes.lead)

    await reopened.memberRouteSet({
      member: 'lead',
      route: {
        provider: 'cmd',
        model: 'deepseek-v4.1-flash',
      },
      updatedBy: 'operator',
    }, { name: 'lead', tier: 0 })
    assert.deepEqual(reopened.memberRoute('lead'), {
      member: 'lead',
      provider: 'cmd',
      model: 'deepseek-v4.1-flash',
      updatedAt: reopened.memberRoute('lead').updatedAt,
      updatedBy: 'operator',
    })
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})
