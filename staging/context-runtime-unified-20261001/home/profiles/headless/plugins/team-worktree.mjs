/**
 * team-worktree — Agent Team v2 / worktree isolation and the merge gate.
 *
 * Every member works in its own git worktree, so two members can never overwrite each
 * other's files. A member integrates into its group lead's branch; a group lead
 * integrates into main. The merge itself is a TOOL plus an approval, not a role: the
 * authority is decided by the tier tree in code, and a merge into main additionally
 * requires a verifier clearance recorded against that exact commit.
 *
 * Conflicts are never auto-resolved implicitly. A caller may opt into one explicit
 * merge-strategy resolution after pinning both heads; otherwise the unmerged paths
 * are reported and escalated to whoever owns the destination branch.
 */
// HMR activation marker: 2026-09-28T16:10+08:00 perf68-worktree-sync-diagnostics.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'team-worktree'
export const inject = ['tools']

export const BRANCH_MAIN = 'main'
export const DEFAULTS = { root: '.dsh-worktrees', remote: 'origin' }

/**
 * The integration branch owned by one group.
 * It deliberately does NOT live under the member namespace: a git ref is a path on
 * disk, so 'team/alpha' and 'team/alpha/a1' cannot coexist — git refuses to create
 * the file 'refs/heads/team/alpha' once the directory 'refs/heads/team/alpha/'
 * exists. Group branches therefore get their own namespace and never collide with
 * any member branch, whatever the member is called.
 */
export function groupBranch(group) { return 'grp/' + group }
/** The working branch owned by one member inside its group. */
export function memberBranch(group, name) { return 'team/' + group + '/' + name }
/** The checkout directory for one branch, flat and collision-free. */
export function worktreePath(root, branch) { return root + '/' + branch.split('/').join('__') }
/** Resolve all worktree paths against an explicit repository root. */
export function absoluteWorktreePath(repo, root, branch) {
  return resolve(repo, root, branch.split('/').join('__'))
}

/**
 * The branch one member integrates INTO.
 * Tier 0 owns main, a group lead owns its group branch, a member owns its own branch.
 */
export function integrationBranch(record) {
  if (record.tier === 0) return BRANCH_MAIN
  if (record.tier === 1) return groupBranch(record.group)
  return memberBranch(record.group, record.name)
}

/**
 * Decide whether `callerName` may merge `targetName`, and where to.
 * @returns an ok plan, or a refusal carrying a machine-readable code.
 */
export function mergePlan(registry, callerName, targetName, getMember) {
  const caller = getMember(registry, callerName)
  const target = getMember(registry, targetName)
  if (caller === undefined) return { ok: false, code: 'unknown-caller' }
  if (target === undefined) return { ok: false, code: 'unknown-target' }
  if (caller.frozen === true) return { ok: false, code: 'caller-frozen' }
  if (target.frozen === true) return { ok: false, code: 'target-frozen' }
  // A member's work lands in its OWN group lead's branch, and nobody else may own it.
  if (target.tier === 2) {
    if (caller.tier !== 1) return { ok: false, code: 'only-the-spawning-lead-may-merge' }
    if (target.parent !== callerName) return { ok: false, code: 'only-the-spawning-lead-may-merge' }
    return { ok: true, source: memberBranch(target.group, target.name), dest: groupBranch(target.group), owner: callerName }
  }
  // A group branch lands in main, and only tier 0 may decide that.
  if (target.tier === 1) {
    if (caller.tier !== 0) return { ok: false, code: 'only-tier-0-may-merge-to-main' }
    return { ok: true, source: groupBranch(target.group), dest: BRANCH_MAIN, owner: callerName, needsClearance: true }
  }
  return { ok: false, code: 'nothing-to-merge' }
}

/**
 * Gate: main accepts a branch only with a verifier clearance on THAT commit.
 * A missing record, a stale commit, or a blocker/major finding all refuse.
 */
export function clearanceGate(record, commit) {
  if (record === undefined || record === null) return { ok: false, code: 'no-verifier-clearance' }
  if (record.commit !== commit) return { ok: false, code: 'clearance-is-for-another-commit' }
  if (record.severity === 'condition') return { ok: true, conditional: true }
  if (record.severity === 'blocker' || record.severity === 'major') return { ok: false, code: 'verifier-found-a-' + record.severity }
  return { ok: true }
}

/** Hash-bound clearance gate; old records remain valid when no extra fields are requested. */
export function clearanceDigestGate(record, expected = {}) {
  const base = clearanceGate(record, expected.commit)
  if (!base.ok) return base
  for (const key of ['treeHash', 'filesHash', 'checksHash', 'evidenceHash', 'reportDigest']) {
    if (expected[key] !== undefined && record[key] !== expected[key]) {
      return { ok: false, code: 'clearance-' + key + '-mismatch' }
    }
  }
  return { ok: true }
}

/** Run one git command and keep its exit code instead of throwing. */
export function runGit(cwd, args, runner) {
  if (typeof runner === 'function') return runner(cwd, args)
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true })
    return { code: 0, stdout: stdout === null ? '' : stdout, stderr: '' }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message === undefined ? error : error.message),
    }
  }
}

/**
 * Resolve Cargo's authoritative target directory for one checkout.
 *
 * Cargo metadata reads the same config, environment, and manifest chain that a
 * later build uses. The returned path is therefore evidence about the checkout,
 * not a guess reconstructed from one config file.
 */
export function cargoTargetDirectory(worktree, runner) {
  const root = resolve(String(worktree ?? ''))
  const manifest = join(root, 'Cargo.toml')
  if (!existsSync(manifest)) {
    return { ok: true, applicable: false, worktree: root, targetDirectory: null }
  }
  const args = ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest]
  const result = typeof runner === 'function'
    ? runner(root, args)
    : runCargo(root, args)
  if (result.code !== 0) {
    return {
      ok: false,
      applicable: true,
      worktree: root,
      targetDirectory: null,
      code: 'cargo-metadata-failed',
      detail: String(result.stderr || result.stdout || '').trim(),
    }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const targetDirectory = typeof parsed?.target_directory === 'string'
      ? resolve(parsed.target_directory)
      : null
    if (targetDirectory === null) {
      return {
        ok: false,
        applicable: true,
        worktree: root,
        targetDirectory: null,
        code: 'cargo-target-missing',
        detail: 'cargo metadata returned no target_directory',
      }
    }
    return { ok: true, applicable: true, worktree: root, targetDirectory }
  } catch (error) {
    return {
      ok: false,
      applicable: true,
      worktree: root,
      targetDirectory: null,
      code: 'cargo-metadata-invalid',
      detail: String(error?.message ?? error),
    }
  }
}

/** Run one cargo command and retain its exit status for cargoTargetDirectory(). */
function runCargo(cwd, args) {
  try {
    const stdout = execFileSync('cargo', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true })
    return { code: 0, stdout: stdout === null ? '' : stdout, stderr: '' }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message === undefined ? error : error.message),
    }
  }
}

function cargoTargetKey(path) {
  const normalized = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Fail closed when two Cargo checkouts resolve to the same target directory.
 * The repository root is included as a baseline by callers, so a worktree that
 * silently inherits the main checkout's target is detected even when it is the
 * only worktree being inspected.
 */
export function cargoTargetIsolationVerdict(worktrees, inspect = cargoTargetDirectory) {
  const unique = new Map()
  for (const row of Array.isArray(worktrees) ? worktrees : []) {
    const id = String(row?.id ?? row?.name ?? row?.path ?? '')
    const path = String(row?.path ?? '')
    if (path.length === 0) continue
    const key = cargoTargetKey(path)
    if (!unique.has(key)) unique.set(key, { id: id || path, path: resolve(path) })
  }
  const targets = []
  const errors = []
  for (const row of unique.values()) {
    const observed = inspect(row.path)
    if (observed?.ok !== true) {
      if (observed?.applicable !== false) {
        errors.push({
          worktree: row.id,
          path: row.path,
          code: String(observed?.code ?? 'cargo-target-unverified'),
          detail: String(observed?.detail ?? 'cargo target directory could not be observed'),
        })
      }
      continue
    }
    if (observed.applicable === false || observed.targetDirectory === null) continue
    targets.push({
      worktree: row.id,
      path: row.path,
      targetDirectory: observed.targetDirectory,
      key: cargoTargetKey(observed.targetDirectory),
    })
  }
  const groups = new Map()
  for (const row of targets) {
    const group = groups.get(row.key) ?? []
    group.push({ worktree: row.worktree, path: row.path })
    groups.set(row.key, group)
  }
  const shared = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      targetDirectory: targets.find((row) => row.key === key)?.targetDirectory ?? key,
      worktrees: rows,
    }))
  return {
    ok: errors.length === 0 && shared.length === 0,
    checked: targets.length,
    targets: targets.map(({ key: _key, ...row }) => row),
    shared,
    errors,
  }
}

function normalizedStatusPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function untrackedPathFromStatusLine(line) {
  if (!line.startsWith('?? ')) return null
  const raw = line.slice(3).trim()
  if (!raw.startsWith('"')) return raw
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw.replace(/^"|"$/g, '')
  }
}

function unstagedTrackedStatusLine(line) {
  return /^ M /.test(String(line ?? ''))
}

/** Split porcelain status into blocking rows and explicitly ignored untracked paths. */
function dirtyStatusInfo(stdout, options = {}) {
  const resolved = typeof options === 'boolean' ? { ignoreUntracked: options } : (options ?? {})
  const ignoreUntracked = resolved.ignoreUntracked === true
  const allowedUntracked = new Set(
    (Array.isArray(resolved.allowedUntracked) ? resolved.allowedUntracked : [])
      .map(normalizedStatusPath)
      .filter(Boolean),
  )
  const dirty = []
  const rawDirty = []
  const ignoredUntracked = []
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const rawLine = raw.replace(/\r$/, '')
    const line = rawLine.trim()
    if (!line) continue
    const path = untrackedPathFromStatusLine(line)
    if (path !== null && (ignoreUntracked || allowedUntracked.has(normalizedStatusPath(path)))) {
      ignoredUntracked.push(path)
      continue
    }
    dirty.push(line)
    rawDirty.push(rawLine)
  }
  return { dirty, rawDirty, ignoredUntracked: [...new Set(ignoredUntracked)] }
}

/** Unmerged paths in a worktree, empty when the merge was clean. */
function dirtyStatusLines(stdout, options) {
  return dirtyStatusInfo(stdout, options).dirty
}

function conflictedFiles(cwd, runner) {
  const out = runGit(cwd, ['diff', '--name-only', '--diff-filter=U'], runner)
  return out.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * Merge one branch in one destination worktree, never resolving conflicts.
 * @returns a structured outcome; the caller decides what to report.
 */
export function mergeBranch(destPath, source, runner) {
  if (runGit(destPath, ['rev-parse', '--git-dir'], runner).code !== 0) return { ok: false, code: 'not-a-git-repository' }
  const before = runGit(destPath, ['rev-parse', 'HEAD'], runner)
  const merge = runGit(destPath, ['merge', '--no-ff', '--no-edit', source], runner)
  if (merge.code === 0) {
    const after = runGit(destPath, ['rev-parse', 'HEAD'], runner)
    return { ok: true, commit: after.stdout.trim(), previous: before.stdout.trim() }
  }
  const files = conflictedFiles(destPath, runner)
  if (files.length > 0) return { ok: false, code: 'merge-conflict', files, escalate: true }
  return { ok: false, code: 'merge-failed', detail: (merge.stderr || merge.stdout).slice(0, 400) }
}

/** Snapshot a source branch and require a clean source checkout. */
export function sourceSnapshot(repo, sourcePath, sourceBranch, runner, options = {}) {
  const branch = runGit(repo, ['rev-parse', sourceBranch], runner)
  if (branch.code !== 0) return { ok: false, code: 'source-branch-missing', detail: branch.stderr || branch.stdout }
  const clean = runGit(sourcePath, ['status', '--porcelain'], runner)
  if (clean.code !== 0) return { ok: false, code: 'source-worktree-invalid', detail: clean.stderr || clean.stdout }
  const dirty = dirtyStatusInfo(clean.stdout, options)
  if (dirty.dirty.length > 0) {
    return {
      ok: false,
      code: 'source-worktree-dirty',
      path: sourcePath,
      branch: sourceBranch,
      files: dirty.dirty,
      ignoredUntracked: dirty.ignoredUntracked,
    }
  }
  return { ok: true, sha: branch.stdout.trim(), ignoredUntracked: dirty.ignoredUntracked }
}

/** Exact-SHA merge primitive. Mutable branch refs are checked before and after the merge. */
export function mergeExact(repo, destPath, sourcePath, sourceBranch, expectedSha, runner, options = {}) {
  const before = sourceSnapshot(repo, sourcePath, sourceBranch, runner, options)
  if (!before.ok) return before
  const sourceHeadBefore = before.sha
  if (sourceHeadBefore !== expectedSha) {
    const sourceContainsExpected = options.allowSourceAncestor === true
      && runGit(repo, ['merge-base', '--is-ancestor', expectedSha, sourceHeadBefore], runner).code === 0
    if (!sourceContainsExpected) {
      return { ok: false, code: 'source-sha-changed', expectedSha, actualSha: sourceHeadBefore }
    }
  }
  const destinationClean = runGit(destPath, ['status', '--porcelain'], runner)
  if (destinationClean.code !== 0) {
    return {
      ok: false,
      code: 'destination-worktree-invalid',
      path: destPath,
      detail: (destinationClean.stderr || destinationClean.stdout || 'git status failed').slice(0, 400),
    }
  }
  const destinationDirty = dirtyStatusInfo(destinationClean.stdout, options)
  if (destinationDirty.dirty.length > 0) {
    return {
      ok: false,
      code: 'destination-worktree-dirty',
      files: destinationDirty.dirty,
      ignoredUntracked: [
        ...new Set([...(before.ignoredUntracked ?? []), ...destinationDirty.ignoredUntracked]),
      ],
    }
  }
  const headBefore = runGit(destPath, ['rev-parse', 'HEAD'], runner).stdout.trim()
  const destinationRef = typeof options.destinationRef === 'string' && options.destinationRef.trim().length > 0
    ? options.destinationRef.trim()
    : undefined
  let destinationRefBefore
  if (destinationRef !== undefined) {
    const symbolic = runGit(destPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], runner)
    const symbolicRef = symbolic.stdout.trim()
    if (symbolic.code !== 0 || symbolicRef.length === 0) {
      return {
        ok: false,
        code: 'destination-is-detached',
        destinationRef,
        destinationRefBefore: symbolicRef || null,
        destinationBefore: headBefore,
      }
    }
    if (symbolicRef !== destinationRef) {
      return {
        ok: false,
        code: 'destination-ref-mismatch',
        destinationRef,
        destinationRefBefore: symbolicRef,
        destinationBefore: headBefore,
      }
    }
    const refBefore = runGit(destPath, ['rev-parse', '--verify', destinationRef + '^{commit}'], runner)
    if (refBefore.code !== 0 || refBefore.stdout.trim() !== headBefore) {
      return {
        ok: false,
        code: 'destination-ref-mismatch',
        destinationRef,
        destinationRefBefore: symbolicRef,
        destinationBefore: headBefore,
        actualRef: refBefore.code === 0 ? refBefore.stdout.trim() : null,
      }
    }
    destinationRefBefore = symbolicRef
  }
  const mergeBaseResult = runGit(destPath, ['merge-base', headBefore, expectedSha], runner)
  const mergeBase = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : null
  const alreadyUpToDate = runGit(
    destPath,
    ['merge-base', '--is-ancestor', expectedSha, headBefore],
    runner,
  ).code === 0
  const fastForward = !alreadyUpToDate && runGit(
    destPath,
    ['merge-base', '--is-ancestor', headBefore, expectedSha],
    runner,
  ).code === 0
  const merge = alreadyUpToDate
    ? { code: 0, stdout: '', stderr: '' }
    : runGit(destPath, ['merge', fastForward ? '--ff-only' : '--no-ff', '--no-edit', expectedSha], runner)
  if (merge.code !== 0) {
    const files = conflictedFiles(destPath, runner)
    if (files.length > 0) return { ok: false, code: 'merge-conflict', files, escalate: true }
    return { ok: false, code: 'merge-failed', detail: (merge.stderr || merge.stdout).slice(0, 400) }
  }
  const after = runGit(repo, ['rev-parse', sourceBranch], runner)
  const sourceBranchHeadAfter = after.stdout.trim()
  const sourceStillContainsExpected = after.code === 0
    && (options.allowSourceAncestor === true
      ? runGit(repo, ['merge-base', '--is-ancestor', expectedSha, sourceBranchHeadAfter], runner).code === 0
      : sourceBranchHeadAfter === expectedSha)
  if (!sourceStillContainsExpected) {
    return { ok: false, code: 'source-sha-changed', expectedSha, actualSha: sourceBranchHeadAfter }
  }
  const head = runGit(destPath, ['rev-parse', 'HEAD'], runner)
  const headSha = head.stdout.trim()
  let destinationRefAfter
  if (destinationRef !== undefined) {
    const symbolicAfter = runGit(destPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], runner)
    const refAfter = runGit(destPath, ['rev-parse', '--verify', destinationRef + '^{commit}'], runner)
    destinationRefAfter = symbolicAfter.code === 0 ? symbolicAfter.stdout.trim() : null
    if (destinationRefAfter !== destinationRef
      || refAfter.code !== 0
      || refAfter.stdout.trim() !== headSha) {
      return {
        ok: false,
        code: 'merge-postcondition-failed',
        expectedSha,
        actualSha: headSha,
        destinationRef,
        destinationRefBefore,
        destinationRefAfter,
        actualRef: refAfter.code === 0 ? refAfter.stdout.trim() : null,
      }
    }
  }
  if (fastForward && headSha !== expectedSha) {
    return { ok: false, code: 'merge-postcondition-failed', expectedSha, actualSha: headSha }
  }
  const ancestor = runGit(destPath, ['merge-base', '--is-ancestor', expectedSha, 'HEAD'], runner)
  if (ancestor.code !== 0) return { ok: false, code: 'merge-postcondition-failed', expectedSha, actualSha: headSha }
  return {
    ok: true,
    commit: headSha,
    previous: headBefore,
    previousMeaning: 'destination-head-before-merge',
    destinationBefore: headBefore,
    destinationRefBefore,
    destinationRefAfter,
    sourceHead: expectedSha,
    sourceBranchHead: sourceHeadBefore,
    sourceBranchHeadAfter,
    mergeBase,
    sourceSha: expectedSha,
    ancestorVerified: true,
    fastForwarded: fastForward,
    createdCommit: !alreadyUpToDate && !fastForward && headSha !== headBefore,
    alreadyUpToDate,
    changed: headSha !== headBefore,
    ignoredUntracked: [
      ...new Set([...(before.ignoredUntracked ?? []), ...destinationDirty.ignoredUntracked]),
    ],
  }
}

/**
 * Small cross-process repository lock. A lock is deliberately fail-fast:
 * callers can retry from their scheduler without holding a model turn.
 */
export async function withMergeLock(repo, fn, options = {}) {
  const lockPath = options.lockName
    ? resolve(repo, options.lockName)
    : join(tmpdir(), 'dsh-merge-locks', createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 20) + '.lock')
  let fd
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
    fd = openSync(lockPath, 'wx')
  } catch {
    return { ok: false, code: 'merge-lock-busy', lock: lockPath }
  }
  try {
    return await fn()
  } finally {
    try { closeSync(fd) } catch {}
    try { unlinkSync(lockPath) } catch {}
  }
}

/**
 * Who may lay out whose worktree.
 * Tier 0 lays out its group leads; a group lead lays out its own members; the
 * verifier lays out its own read-only checkout and nothing else. Nobody lays out
 * another group's work.
 * @returns an ok plan with the branch to check out, or a refusal.
 */
export function setupPlan(registry, callerName, targetName, getMember) {
  const caller = getMember(registry, callerName)
  const target = getMember(registry, targetName)
  if (caller === undefined) return { ok: false, code: 'unknown-caller' }
  if (target === undefined) return { ok: false, code: 'unknown-target' }
  if (target.frozen === true) return { ok: false, code: 'target-frozen' }
  // The verifier is the one member whose checkout is deliberately read-only: it is
  // created detached at a commit, so it can read and run the code but has no branch
  // to commit a "fix" into. Only the verifier may lay out its own.
  if (target.group === 'verifier') {
    if (callerName !== targetName) return { ok: false, code: 'only-the-verifier-lays-out-its-own-read-only-checkout' }
    return { ok: true, branch: memberBranch('verifier', target.name), readOnly: true, base: BRANCH_MAIN }
  }
  if (target.tier === 1) {
    if (caller.tier !== 0) return { ok: false, code: 'only-tier-0-lays-out-a-group-lead' }
    return { ok: true, branch: groupBranch(target.group), readOnly: false, base: BRANCH_MAIN }
  }
  if (target.tier === 2) {
    if (caller.tier !== 1 || target.parent !== callerName) return { ok: false, code: 'only-the-spawning-lead-lays-out-its-member' }
    return { ok: true, branch: memberBranch(target.group, target.name), readOnly: false, base: groupBranch(target.group) }
  }
  return { ok: false, code: 'nothing-to-lay-out' }
}

/**
 * Create one worktree, idempotently.
 * A read-only checkout is created DETACHED at the given commit: that is the git-level
 * guarantee that the verifier cannot commit to a branch by accident.
 * @returns a structured outcome; an existing worktree is reported, not duplicated.
 */
function headSnapshot(path, runner) {
  const headResult = runGit(path, ['rev-parse', 'HEAD'], runner)
  const head = headResult.code === 0 ? headResult.stdout.trim() : null
  if (!head) return { head: null, parents: [], headKind: 'unknown' }
  const parentsResult = runGit(path, ['rev-list', '--parents', '-n', '1', 'HEAD'], runner)
  const parents = parentsResult.code === 0
    ? parentsResult.stdout.trim().split(/\s+/).filter(Boolean).slice(1)
    : []
  return {
    head,
    parents,
    headKind: parents.length === 0 ? 'root' : parents.length === 1 ? 'single-parent' : 'merge',
  }
}

function worktreeOutcome(path, branch, readOnly, created, previousHead, runner, ignoredUntracked = []) {
  const state = headSnapshot(path, runner)
  return {
    ok: true,
    path,
    branch,
    readOnly: readOnly === true,
    created: created === true,
    previousHead: previousHead ?? null,
    head: state.head,
    parents: state.parents,
    headKind: state.headKind,
    mergeCommitCreated: previousHead !== null
      && previousHead !== undefined
      && state.head !== previousHead
      && state.parents.length > 1,
    ignoredUntracked: [...new Set(ignoredUntracked)],
  }
}

export function worktreeAdd(repo, path, branch, base, runner, readOnly, options = {}) {
  if (runGit(repo, ['rev-parse', '--git-dir'], runner).code !== 0) return { ok: false, code: 'not-a-git-repository' }
  const listed = runGit(repo, ['worktree', 'list', '--porcelain'], runner).stdout
  const branchContainsBase = () => {
    if (readOnly === true || typeof base !== 'string' || base.length === 0) return true
    return runGit(repo, ['merge-base', '--is-ancestor', base, branch], runner).code === 0
  }
  const isAncestor = (ancestor, descendant) =>
    runGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant], runner).code === 0
  const branchSha = () => runGit(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], runner).stdout.trim()
  const baseSha = () => runGit(repo, ['rev-parse', '--verify', '--quiet', base], runner).stdout.trim()
  const listedWorktree = listed.includes('worktree ' + path.split('\\').join('/'))
  const refreshStaleBranch = () => {
    if (readOnly === true || typeof base !== 'string' || base.length === 0) {
      return { ok: false, code: 'worktree-stale-base', detail: 'the branch does not contain the requested base' }
    }
    const left = branchSha()
    const right = baseSha()
    if (!left || !right || left === right) {
      return { ok: false, code: 'worktree-stale-base', detail: 'cannot resolve the branch or requested base' }
    }
    const conflictStrategy = options.conflictStrategy === undefined
      ? undefined
      : String(options.conflictStrategy).trim().toLowerCase()
    const expectedHead = String(options.expectedHead ?? '').trim()
    const expectedBase = String(options.expectedBase ?? '').trim()
    if (conflictStrategy !== undefined) {
      if (!['base', 'worktree'].includes(conflictStrategy)) {
        return { ok: false, code: 'worktree-conflict-strategy-invalid', head: left, baseSha: right }
      }
      if (!/^[0-9a-f]{40}$/i.test(expectedHead) || !/^[0-9a-f]{40}$/i.test(expectedBase)) {
        return {
          ok: false,
          code: 'worktree-conflict-precondition-required',
          head: left,
          baseSha: right,
          detail: 'conflict_strategy requires expected_head and expected_base as full 40-character commit SHAs',
        }
      }
      if (left !== expectedHead || right !== expectedBase) {
        return {
          ok: false,
          code: 'worktree-conflict-precondition-changed',
          head: left,
          baseSha: right,
          expectedHead,
          expectedBase,
        }
      }
    }
    let createdWorktree = false
    if (!listedWorktree) {
      const add = runGit(repo, ['worktree', 'add', path, branch], runner)
      if (add.code !== 0) {
        return { ok: false, code: 'worktree-failed', detail: (add.stderr || add.stdout).slice(0, 300) }
      }
      createdWorktree = true
    }
    const cleanup = () => {
      if (createdWorktree) runGit(repo, ['worktree', 'remove', '--force', path], runner)
    }
    const status = runGit(path, ['status', '--porcelain'], runner)
    const behindResult = runGit(path, ['rev-list', '--count', branch + '..' + base], runner)
    const behind = behindResult.code === 0 && /^\d+$/.test(behindResult.stdout.trim())
      ? Number(behindResult.stdout.trim())
      : null
    const statusInfo = status.code === 0 ? dirtyStatusInfo(status.stdout, options) : { dirty: [], ignoredUntracked: [] }
    const dirtyFiles = statusInfo.dirty
    const rawDirtyFiles = Array.isArray(statusInfo.rawDirty) ? statusInfo.rawDirty : dirtyFiles
    // Git preserves unstaged edits when they do not overlap the merge and
    // refuses the merge when they do. Staged, conflicted or unknown dirty rows
    // remain fail-closed because a merge could otherwise absorb them.
    const allowedUnstaged = new Set()
    if (options.allowTrackedUnstaged === true) {
      rawDirtyFiles.forEach((line, index) => {
        if (unstagedTrackedStatusLine(line)) allowedUnstaged.add(index)
      })
    }
    const preservedTrackedUnstaged = rawDirtyFiles.filter((_line, index) => allowedUnstaged.has(index))
    const blockingDirtyFiles = dirtyFiles.filter((_line, index) => !allowedUnstaged.has(index))
    if (status.code !== 0 || blockingDirtyFiles.length > 0) {
      cleanup()
      return {
        ok: false,
        code: 'worktree-refresh-dirty',
        behind,
        dirtyCount: blockingDirtyFiles.length,
        dirtyFiles: blockingDirtyFiles,
        ignoredUntracked: statusInfo.ignoredUntracked,
        nextStep: 'git merge ' + base,
        detail: 'the existing worktree is not clean; behind=' + String(behind ?? 'unknown')
          + ', dirty=' + String(blockingDirtyFiles.length)
          + '; commit or remove its changes, then run `git merge ' + base + '`',
      }
    }
    // A pure ancestor can fast-forward. A divergent branch must merge the base:
    // rebasing would rewrite commits that may already be bound to packets/evidence.
    const mergeArgs = isAncestor(branch, base)
      ? ['merge', '--ff-only', base]
      : [
          'merge', '--no-ff', '--no-edit',
          ...(conflictStrategy === undefined
            ? []
            : ['-X', conflictStrategy === 'base' ? 'theirs' : 'ours']),
          base,
        ]
    const merge = runGit(path, mergeArgs, runner)
    if (merge.code !== 0) {
      const files = conflictedFiles(path, runner)
      runGit(path, ['merge', '--abort'], runner)
      cleanup()
      return {
        ok: false,
        code: files.length > 0 ? 'worktree-stale-base-merge-conflict' : 'worktree-stale-base-merge-failed',
        files,
        head: left,
        baseSha: right,
        conflictStrategy,
        detail: (merge.stderr || merge.stdout || 'git merge failed').slice(0, 400),
      }
    }
    if (!branchContainsBase()) {
      cleanup()
      return { ok: false, code: 'worktree-stale-base', detail: 'merge completed but the branch still does not contain the requested base' }
    }
    return {
      ...worktreeOutcome(path, branch, false, createdWorktree, left, runner, statusInfo.ignoredUntracked),
      sourceHeadBefore: left,
      baseHeadBefore: right,
      ...(preservedTrackedUnstaged.length > 0 ? { preservedTrackedUnstaged } : {}),
      ...(conflictStrategy === undefined ? {} : { conflictStrategy }),
    }
  }
  if (listedWorktree) {
    if (!branchContainsBase()) {
      const refreshed = refreshStaleBranch()
      if (refreshed.ok === true) {
        return refreshed
      }
      return {
        ok: false,
        code: refreshed.code,
        files: refreshed.files,
        head: refreshed.head,
        baseSha: refreshed.baseSha,
        conflictStrategy: refreshed.conflictStrategy,
        behind: refreshed.behind,
        dirtyCount: refreshed.dirtyCount,
        dirtyFiles: refreshed.dirtyFiles,
        ignoredUntracked: refreshed.ignoredUntracked,
        nextStep: refreshed.nextStep,
        detail: 'existing worktree branch "' + branch + '" does not contain requested base "' + base
          + '"; automatic safe merge failed: ' + String(refreshed.detail ?? refreshed.code)
          + '; run `git merge ' + base + '` inside ' + path
          + ' after resolving any conflict (do not rebase commits already bound to packets/evidence)',
      }
    }
    const current = headSnapshot(path, runner)
    return worktreeOutcome(path, branch, readOnly, false, current.head, runner)
  }
  const exists = runGit(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], runner).code === 0
  const previousHead = exists ? branchSha() : null
  if (exists && !branchContainsBase()) {
    const refreshed = refreshStaleBranch()
    if (refreshed.ok !== true) {
      return {
        ok: false,
        code: refreshed.code,
        files: refreshed.files,
        head: refreshed.head,
        baseSha: refreshed.baseSha,
        conflictStrategy: refreshed.conflictStrategy,
        behind: refreshed.behind,
        dirtyCount: refreshed.dirtyCount,
        dirtyFiles: refreshed.dirtyFiles,
        ignoredUntracked: refreshed.ignoredUntracked,
        nextStep: refreshed.nextStep,
        detail: 'branch "' + branch + '" does not contain requested base "' + base
          + '"; automatic safe merge failed: ' + String(refreshed.detail ?? refreshed.code)
          + '; merge the base into this branch without rebasing: `git merge ' + base + '`'
          + ' (do not rewrite commits already bound to packets/evidence)',
      }
    }
    if (refreshed.created === true) {
      return refreshed
    }
  }
  const args = readOnly === true
    ? ['worktree', 'add', '--detach', path, base === undefined ? branch : base]
    : exists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, base === undefined ? 'main' : base]
  const out = runGit(repo, args, runner)
  if (out.code !== 0) return { ok: false, code: 'worktree-failed', detail: (out.stderr || out.stdout).slice(0, 300) }
  return worktreeOutcome(path, branch, readOnly, true, readOnly === true ? null : previousHead, runner)
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config === null || config === undefined ? {} : config)
  void cfg
  void ctx
}
