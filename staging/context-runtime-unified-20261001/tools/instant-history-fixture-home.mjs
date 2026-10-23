import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = fileURLToPath(new URL('../', import.meta.url))
const template = join(stage, 'lab-host-home')
const normalized = value => resolve(value).replaceAll('\\', '/').toLowerCase()

// Reuse the prepared canonical profile, but never copy its accumulated runtime state.
export function prepareInstantHistoryHome(home) {
  const target = realpathSync(home)
  assert.ok(normalized(target).startsWith(normalized(join(stage, '../../output')) + '/')
    || normalized(target).startsWith(normalized(join(stage, 'lab-runs')) + '/'), 'INSTANT_HOME_OUTSIDE_FIXTURE_ROOT')
  assert.deepEqual(readdirSync(target), [], 'INSTANT_HOME_NOT_EMPTY')
  const preparation = JSON.parse(readFileSync(join(template, 'preparation-evidence.json')))
  assert.equal(preparation.prepared, true)
  const profile = join(target, 'profiles/web')
  mkdirSync(profile, { recursive: true })
  const remap = text => text.replaceAll(template.replaceAll('\\', '/'), target.replaceAll('\\', '/'))
    .replaceAll(template, target).replaceAll(template.replaceAll('\\', '\\\\'), target.replaceAll('\\', '\\\\'))
  const files = ['cordis.patch.yml', 'profiles/web/cordis.yml', 'profiles/web/cordis.patch.yml', 'profiles/web/package.json',
    'team-roles/AGENTS.md', 'team-roles/root.md', 'team-roles/lead.md', 'team-roles/member.md', 'team-roles/verifier.md', 'team-roles/identity-version.json',
    'write-scopes.json', 'evidence-reducer.json']
  for (const name of files) {
    mkdirSync(resolve(target, name, '..'), { recursive: true })
    if (name.endsWith('.yml')) writeFileSync(join(target, name), remap(readFileSync(join(template, name), 'utf8')))
    else copyFileSync(join(template, name), join(target, name))
  }
  symlinkSync(join(stage, 'app/node_modules'), join(profile, 'node_modules'), 'junction')
  const receipt = { kind: 'instant-history-fresh-home-v1', home: target, template, inheritedRuntimeState: false,
    sessionsInitiallyAbsent: !existsSync(join(target, 'sessions')), controlInitiallyAbsent: !existsSync(join(target, 'team-control-plane')) }
  writeFileSync(join(target, 'instant-home.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}

export function assertInstantHistoryHome(home) {
  const target = realpathSync(home)
  const receipt = JSON.parse(readFileSync(join(target, 'instant-home.json')))
  assert.equal(receipt.kind, 'instant-history-fresh-home-v1')
  assert.equal(normalized(receipt.home), normalized(target))
  assert.equal(receipt.inheritedRuntimeState, false)
  const patch = readFileSync(join(target, 'profiles/web/cordis.patch.yml'), 'utf8')
  assert.ok(!patch.includes(template.replaceAll('\\', '/')) && !patch.includes(template), 'INSTANT_SHARED_HOME_REFERENCE')
  return receipt
}
