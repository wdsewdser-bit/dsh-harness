import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs'
import { relative, isAbsolute, resolve, join } from 'node:path'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'
import { readExactPlanFile } from './team-v15-plan-refs.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function contained(root, path) {
  const delta = relative(root, path)
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\'))
}

/** Hash the complete declared source scopes, including dirty and untracked
 * files. No task/evidence field can stand in for the current physical tree. */
export function collectDeliverySource(plan, { workspaceRoot, maxFiles = 4096, maxBytes = 67108864 } = {}) {
  if (!workspaceRoot || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('DELIVERY_SOURCE_UNAVAILABLE')
  const root = realpathSync(workspaceRoot)
  const paths = new Set(), directories = new Set(), rows = []
  let bytes = 0
  function visit(logical) {
    const physical = realpathSync(logical)
    if (!contained(root, physical)) fail('DELIVERY_SOURCE_PATH_DENIED')
    const stat = lstatSync(physical)
    if (stat.isDirectory()) {
      if (directories.has(physical)) fail('DELIVERY_SOURCE_ALIAS_OR_CYCLE')
      directories.add(physical)
      for (const name of readdirSync(physical).sort()) visit(join(logical, name))
      return
    }
    if (!stat.isFile()) fail('DELIVERY_SOURCE_TYPE_UNSUPPORTED')
    const name = relative(root, resolve(logical)).replaceAll('\\', '/')
    if (paths.has(name)) return
    if (rows.length >= maxFiles || stat.size + bytes > maxBytes) fail('DELIVERY_SOURCE_BUDGET_EXCEEDED')
    const content = readFileSync(physical)
    if (content.length + bytes > maxBytes) fail('DELIVERY_SOURCE_BUDGET_EXCEEDED')
    if (realpathSync(logical) !== physical) fail('DELIVERY_SOURCE_CHANGED')
    paths.add(name); bytes += content.length
    rows.push({ path: name, physicalPath: physical, bytes: content.length, sha256: sha(content) })
  }
  const scopes = [...plan.scope].sort()
  for (const scope of scopes) {
    const target = resolve(root, scope)
    if (!contained(root, target)) fail('DELIVERY_SOURCE_PATH_DENIED')
    visit(target)
  }
  rows.sort((a, b) => a.path.localeCompare(b.path))
  return { sourceIdentity: { manifestHash: planDeliveryHash({ root, scope: scopes, files: rows }) },
    manifest: { root, scope: scopes, files: rows, bytes } }
}

export function collectDeliveryContext(state, plan, policy, { agent, sessionId } = {}) {
  const source = collectDeliverySource(plan, policy)
  const readOptions = { allowedRoots: policy.allowedRoots ?? [] }
  if (!Array.isArray(policy.environmentRefs) || !policy.environmentRefs.length || !policy.recipeRef) fail('DELIVERY_ENVIRONMENT_UNAVAILABLE')
  const environmentRefs = policy.environmentRefs.map(ref => ({ ref,
    physicalPath: readExactPlanFile(ref, readOptions).physical }))
  const recipe = readExactPlanFile(policy.recipeRef, readOptions)
  const environmentFingerprint = planDeliveryHash({ node: process.version, platform: process.platform, arch: process.arch, environmentRefs })
  const recipeFingerprint = planDeliveryHash({ ref: policy.recipeRef, physicalPath: recipe.physical })
  if (typeof policy.collectAuthorityDebt !== 'function') fail('DELIVERY_DEBT_COLLECTOR_UNAVAILABLE')
  if (policy.collectAuthorityDebt.constructor?.name === 'AsyncFunction') fail('DELIVERY_DEBT_UNVERIFIED')
  const debt = policy.collectAuthorityDebt(structuredClone(state), structuredClone(plan), { agent, sessionId })
  if (debt?.then || !Array.isArray(debt?.unresolvedDebt) || !Array.isArray(debt?.blockers)) fail('DELIVERY_DEBT_UNVERIFIED')
  const unresolvedDebt = [...debt.unresolvedDebt]
  for (const row of Object.values(state.v15PlanReadReceipts ?? {})) {
    if (row.planId === plan.planId && row.planRevision === plan.planRevision && row.requiredFetch === true) unresolvedDebt.push('plan-read:' + row.id)
  }
  if (agent?.inbox?.nextStep?.length || agent?.inbox?.nextTurn?.length) unresolvedDebt.push('pending-input')
  return { revision: 1, sourceIdentity: source.sourceIdentity, scope: [...plan.scope], environmentFingerprint, recipeFingerprint,
    unresolvedDebt: [...new Set(unresolvedDebt)], blockers: [...new Set(debt.blockers)], sourceManifest: source.manifest,
    ...(debt.authorityDebtSnapshot ? { authorityDebtSnapshot: structuredClone(debt.authorityDebtSnapshot) } : {}) }
}
