import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-scope-plan-'))
const workspace = join(root, 'workspace')
const controlDir = join(root, 'control')
const scopesFile = join(root, 'scopes.json')
mkdirSync(join(workspace, 'src', 'ui'), { recursive: true })
mkdirSync(join(workspace, 'src', 'ai'), { recursive: true })
mkdirSync(join(workspace, 'docs'), { recursive: true })
writeFileSync(scopesFile, JSON.stringify({ rootDir: workspace, defaultDeny: true, byName: {}, bySession: {} }))
const agent = { name: 'a1', session: { id: 'session-a1' } }
const ctx = {
  agentTeams: { tryMembership: () => ({ id: 'team-scope', name: 'a1', role: 'teammate' }) },
  logger: { warn() {} },
  on(event, listener) { this[event] = listener },
}
const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\write-scope-guard.mjs').href)
try {
  resetControlPlaneCache()
  const cp = controlPlaneFor('team-scope', { directory: controlDir })
  await cp.planPropose({
    taskId: 'task-scope',
    requirementId: 'REQ-SCOPE',
    goal: 'edit UI',
    members: ['a1'],
    writeScopes: ['src/ui'],
    checks: { member: ['node --check src/ui/a.mjs'] },
    rollback: 'revert',
    proposedBy: 'lead',
  })
  await cp.planApprove({ taskId: 'task-scope', approvedBy: 'lead' })
  const lease = await cp.leaseAcquire({ member: 'a1', taskId: 'task-scope' })
  const registrations = []
  const listenerCtx = { ...ctx, on(event, listener, options) { registrations.push({ event, listener, options }) } }
  mod.apply(listenerCtx, { scopesFile, controlDir, enforce: true })
  const guard = registrations.find((x) => x.event === 'fs/write-intent').listener
  const target = (p) => ({ displayPath: p, targetKey: resolve(p) })
  let inScope = true
  try { guard(target(join(workspace, 'src', 'ui', 'a.mjs')), { agent }); } catch { inScope = false }
  let outScope = false
  try { guard(target(join(workspace, 'src', 'ai', 'a.mjs')), { agent }) } catch (error) { outScope = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
  await cp.leaseRelease({ runId: lease.runId, status: 'completed' })
  let afterLease = false
  try { guard(target(join(workspace, 'src', 'ui', 'b.mjs')), { agent }) } catch (error) { afterLease = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
  console.log((inScope ? 'PASS ' : 'FAIL ') + 'approved active lease grants only plan scope')
  console.log((outScope ? 'PASS ' : 'FAIL ') + 'active plan scope rejects sibling path')
  console.log((afterLease ? 'PASS ' : 'FAIL ') + 'scope closes when run lease ends')

  // A member whose session cwd is the repository must resolve a plan scope
  // against that cwd even when the configured rootDir is the parent workspace.
  const repoAgent = { name: 'a2', session: { id: 'session-a2', header: { cwd: join(workspace, 'mc189-rs') } } }
  const repoMembership = { id: 'team-repo-scope', name: 'a2', role: 'teammate' }
  const repoCtx = {
    agentTeams: { tryMembership: () => repoMembership },
    logger: { warn() {} },
    on(event, listener, options) { this[event] = { listener, options } },
  }
  const repoControl = controlPlaneFor('team-repo-scope', { directory: controlDir })
  await repoControl.planPropose({
    taskId: 'task-repo-scope', requirementId: 'REQ-REPO', goal: 'repo docs',
    members: ['a2'], writeScopes: ['docs/plan'], checks: { file: ['test -f docs/plan/x.md'] },
    rollback: 'revert', proposedBy: 'lead',
  })
  await repoControl.planApprove({ taskId: 'task-repo-scope', approvedBy: 'lead' })
  await repoControl.leaseAcquire({ member: 'a2', taskId: 'task-repo-scope' })
  mkdirSync(join(workspace, 'mc189-rs', 'docs', 'plan'), { recursive: true })
  mod.apply(repoCtx, { scopesFile, controlDir, enforce: true })
  let repoAllowed = true
  try { repoCtx['fs/write-intent'].listener(target(join(workspace, 'mc189-rs', 'docs', 'plan', 'x.md')), { agent: repoAgent }); }
  catch { repoAllowed = false }
  console.log((repoAllowed ? 'PASS ' : 'FAIL ') + 'plan scope resolves against the session repository cwd')

  // Shell writes are checked by the same guard, so a member cannot bypass the
  // plan gate with Set-Content or redirection.
  let shellDenied = false
  const pre = repoCtx['tools/pre-execute']
  if (pre === undefined) {
    console.log('FAIL shell write gate installed')
  } else {
    try {
      await pre.listener({ tool: { name: 'pwsh' }, arguments: { command: `Set-Content -Path "${join(workspace, 'mc189-rs', 'src', 'escape.md')}" -Value x` }, agent: repoAgent }, async () => ({ kind: 'allow' }))
    } catch (error) { shellDenied = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
    console.log((shellDenied ? 'PASS ' : 'FAIL ') + 'shell write outside the active plan is denied')

    let inlineDenied = false
    try {
      await pre.listener({ tool: { name: 'pwsh' }, arguments: { command: `node -e "require('fs').writeFileSync('${join(workspace, 'mc189-rs', 'src', 'inline-escape.md')}','x')"` }, agent: repoAgent }, async () => ({ kind: 'allow' }))
    } catch (error) { inlineDenied = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
    console.log((inlineDenied ? 'PASS ' : 'FAIL ') + 'inline interpreter writes are denied as opaque')

    let variableDenied = false
    try {
      await pre.listener({ tool: { name: 'pwsh' }, arguments: { command: `$p="${join(workspace, 'mc189-rs', 'src', 'variable-escape.md')}"; Set-Content -Path $p -Value x` }, agent: repoAgent }, async () => ({ kind: 'allow' }))
    } catch (error) { variableDenied = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
    console.log((variableDenied ? 'PASS ' : 'FAIL ') + 'dynamic shell write targets are denied as opaque')
  }

  // Real tier-0 shape: the root Agent has no `name`, its Team membership name
  // is `lead`, and the control plane records the lease under that member name.
  const rootAgent = {
    id: 'session-root',
    session: { id: 'session-root' },
    ctx: {},
  }
  const rootMembership = { id: 'team-root-scope', name: 'lead', role: 'lead', root: rootAgent }
  rootAgent.ctx.agentTeams = { tryMembership: (candidate) => candidate === rootAgent ? rootMembership : undefined }
  const rootControl = controlPlaneFor('team-root-scope', { directory: controlDir })
  await rootControl.planPropose({
    taskId: 'task-root-scope',
    requirementId: 'REQ-ROOT-SCOPE',
    goal: 'edit root docs',
    members: ['lead'],
    writeScopes: ['docs'],
    checks: { root: ['test -f docs/00.md'] },
    rollback: 'revert',
    proposedBy: 'lead',
  })
  await rootControl.planApprove({ taskId: 'task-root-scope', approvedBy: 'lead' })
  await rootControl.leaseAcquire({ member: 'lead', taskId: 'task-root-scope' })
  const rootRegistrations = []
  const rootCtx = {
    agentTeams: { tryMembership: rootAgent.ctx.agentTeams.tryMembership },
    logger: { warn() {} },
    on(event, listener, options) { rootRegistrations.push({ event, listener, options }) },
  }
  mod.apply(rootCtx, { scopesFile, controlDir, enforce: true })
  const rootGuard = rootRegistrations.find((x) => x.event === 'fs/write-intent').listener
  let rootInScope = true
  try {
    rootGuard(target(join(workspace, 'docs', '00.md')), { agent: rootAgent })
  } catch {
    rootInScope = false
  }
  let rootOutScope = false
  try { rootGuard(target(join(workspace, 'src', 'ui', 'x.mjs')), { agent: rootAgent }); }
  catch (error) { rootOutScope = error?.code === 'FS_WRITE_OUT_OF_SCOPE' }
  console.log((rootInScope ? 'PASS ' : 'FAIL ') + 'root membership name resolves its active plan lease')
  console.log((rootOutScope ? 'PASS ' : 'FAIL ') + 'root active plan still rejects outside-scope writes')
} finally {
  rmSync(root, { recursive: true, force: true })
}
