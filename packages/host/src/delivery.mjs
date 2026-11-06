import fs from 'node:fs';
import path from 'node:path';
import { fail, failWith } from '../../contracts/index.mjs';
import { certificateIsSigned, createDeliveryPort } from '../../delivery/index.mjs';
import { digest } from '../../core/index.mjs';

/**
 * The host half of Delivery: decisions, one transaction per state change, no external IO in the transaction; §3.7.
 *
 * The port (packages/delivery) returns evidence; this module decides what that evidence supports and applies it with
 * the `delivery.transition` reducer. The repository row and the task row are written in the same transaction, so a
 * task can never name a delivery that is not accepted. A readback that could not finish (a Git or verifier timeout, an
 * unparsable answer) closes the row as `unknown` with the reason kept - never as a guessed success and never retried
 * here; the operator adjudication exit is the only way out of `unknown`.
 */
const REVIEW_MS = 60000;

export function createHostDelivery({ core = null, access = null, repository = null, gitRoots = null, timeoutMs = undefined,
  port = null, now = Date.now } = {}) {
  if (!core || typeof core.store?.read !== 'function') failWith('INVALID_CONFIG', 'host delivery needs the team core for its durable reads');
  if (typeof now !== 'function') failWith('INVALID_CONFIG', 'host delivery needs a now() function');
  const reader = port ?? createDeliveryPort({ repository, ...(gitRoots ? { gitRoots } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const routeOf = options => options?.route ?? (access ? access.lifecycle() : null);
  const dispatch = (entityId, actor, payload, command, options) => {
    const route = routeOf(options);
    return route ? route.dispatch(entityId, actor, payload, command) : core.dispatch(entityId, actor, payload, command);
  };
  const mustRead = deliveryId => {
    const current = core.store.read(deliveryId);
    if (!current) fail('MISSING_REFERENCE');
    return { ...current, taskRevision: core.store.read(current.taskId)?.revision ?? 0 };
  };
  /** `actor` chooses the dispatch actor; every other key is the transition's own field set. */
  const transition = (deliveryId, from, values, options = {}) => {
    const { actor = 'root', ...fields } = values;
    const payload = { deliveryId, from: from.status, revision: from.revision, taskRevision: from.taskRevision, ...fields };
    return dispatch(deliveryId, actor, payload, { type: 'delivery.transition', payload }, options).result;
  };
  const closeUnknown = (deliveryId, from, evidence, options = {}) => transition(deliveryId, from, {
    status: 'unknown', reason: evidence.reason ?? evidence.code ?? 'the git readback is uncertain', responsible: 'operator',
    lastEvidence: { code: evidence.code ?? null, at: now() }, nextReviewAt: now() + REVIEW_MS, actor: 'root' }, options);
  const readback = async (work, deliveryId, from, options = {}) => {
    const result = await work;
    if (result && result.unknown) return { unknown: true, value: closeUnknown(deliveryId, from, result, options) };
    if (!result || !result.ok) fail(result?.code ?? 'GIT_FAILED');
    return { value: result.value };
  };

  async function worktree(taskId, owner, options = {}) {
    const deliveryId = 'delivery:' + taskId;
    const prior = core.store.read(deliveryId) ? mustRead(deliveryId) : null;
    if (prior) {
      if (prior.owner !== owner) fail('OWNER_CONFLICT');
      if (prior.status !== 'creating') return prior;
      // A half-created worktree is a real state: only the exact recorded base proves it is the one we meant.
      const existed = fs.existsSync(prior.directory) ? await reader.revParse(prior.directory, 'HEAD') : null;
      if (existed?.ok && existed.value === prior.base) {
        return transition(deliveryId, prior, { status: 'ready', actor: 'root' }, options);
      }
      fail('WORKTREE_UNKNOWN');
    }
    // Validate the derived target before even starting the base readback.
    const directory = reader.worktreePath(taskId);
    // Read the base before the transaction opens: a reducer never runs external IO.
    const baseRead = await reader.revParse(reader.repository, 'HEAD');
    if (!baseRead.ok) fail(baseRead.unknown ? 'WORKTREE_UNKNOWN' : (baseRead.code ?? 'GIT_FAILED'));
    const base = baseRead.value;
    dispatch(deliveryId, 'root', { directory }, { type: 'delivery.put',
      payload: { deliveryId, row: { taskId, owner, directory, status: 'creating', base } } }, options);
    const creating = mustRead(deliveryId);
    const created = await reader.worktreeAdd(directory, base);
    if (!created.ok) fail(created.unknown ? 'WORKTREE_UNKNOWN' : (created.code ?? 'WORKTREE_MISMATCH'));
    return transition(deliveryId, creating, { status: 'ready', actor: 'root' }, options);
  }

  async function produce(taskId, options = {}) {
    const deliveryId = 'delivery:' + taskId;
    const current = mustRead(deliveryId);
    const dirty = await readback(reader.dirty(current.directory), deliveryId, current, options);
    if (dirty.unknown) return dirty.value;
    if ((dirty.value ?? '') !== '') fail('DIRTY_WORKTREE');
    const head = await readback(reader.revParse(current.directory, 'HEAD'), deliveryId, current, options);
    if (head.unknown) return head.value;
    const tree = await readback(reader.tree(current.directory, 'HEAD'), deliveryId, current, options);
    if (tree.unknown) return tree.value;
    return transition(deliveryId, current, { status: 'produced', candidate: head.value, tree: tree.value, actor: 'root' }, options);
  }

  async function verify(taskId, verifier, evidence, options = {}) {
    const deliveryId = 'delivery:' + taskId;
    const current = mustRead(deliveryId);
    if (verifier === current.owner || !evidence) fail('NOT_INDEPENDENT');
    const task = core.store.read(taskId);
    if (!task?.approved || core.store.read(verifier)?.role !== 'verifier') fail('MISSING_VERIFICATION_CONTRACT');
    const dirty = await readback(reader.dirty(current.directory), deliveryId, current, options);
    if (dirty.unknown) return dirty.value;
    const head = await readback(reader.revParse(current.directory, 'HEAD'), deliveryId, current, options);
    if (head.unknown) return head.value;
    if ((dirty.value ?? '') !== '' || head.value !== current.candidate) fail('STALE_CANDIDATE');
    const request = { taskId, ...(task.attemptId ? { attemptId: task.attemptId } : {}), candidate: current.candidate,
      tree: current.tree, base: current.base, verifier, evidence,
      allowedPaths: task.scopeSet.map(scope => path.relative(current.directory, scope).replaceAll(path.sep, '/')),
      contractRevision: task.contractRevision,
      contractHash: digest({ scopeSet: task.scopeSet, contractRevision: task.contractRevision, approved: task.approved }) };
    const answer = await reader.verify({ directory: current.directory, request });
    if (answer.unknown) return closeUnknown(deliveryId, current, answer, options);
    if (!answer.ok) fail(answer.code ?? 'VERIFIER_FAILED');
    if (!certificateIsSigned(answer.certificate, answer.signature, answer.publicKey)) fail('INVALID_SIGNATURE');
    return transition(deliveryId, current, { status: 'verified', certificate: answer.certificate,
      signature: answer.signature, publicKey: answer.publicKey,
      certificateHash: answer.certificateHash ?? digest(answer.certificate), actor: 'root' }, options);
  }

  async function integrate(taskId, target = 'refs/heads/main', hook = () => {}, options = {}) {
    const deliveryId = 'delivery:' + taskId;
    const current = mustRead(deliveryId);
    if (!/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(target)) fail('INVALID_TARGET_REF');
    const status = current.status;
    const targetDirty = await readback(reader.dirty(reader.repository), deliveryId, current, options);
    if (targetDirty.unknown) return targetDirty.value;
    if ((targetDirty.value ?? '') !== '') fail('DIRTY_TARGET_WORKTREE');
    const task = core.store.read(taskId);
    if ((task?.contractRevision ?? 1) !== current.certificate?.contractRevision) fail('STALE_CONTRACT');
    if (status !== 'verified' || !current.certificate || digest(current.certificate) !== current.certificateHash ||
      !certificateIsSigned(current.certificate, current.signature, current.publicKey)) fail('NO_CERTIFICATE');
    if (digest({ scopeSet: task.scopeSet, contractRevision: task.contractRevision, approved: task.approved }) !== current.certificate.contractHash) fail('STALE_CONTRACT');
    const candidateDirty = await readback(reader.dirty(current.directory), deliveryId, current, options);
    if (candidateDirty.unknown) return candidateDirty.value;
    const head = await readback(reader.revParse(current.directory, 'HEAD'), deliveryId, current, options);
    if (head.unknown) return head.value;
    if ((candidateDirty.value ?? '') !== '' || head.value !== current.candidate) fail('STALE_CANDIDATE');
    const targetHead = await readback(reader.revParse(reader.repository, target), deliveryId, current, options);
    if (targetHead.unknown) return targetHead.value;
    if (targetHead.value !== current.base) fail('TARGET_MOVED');
    const ancestor = await readback(reader.ancestor(reader.repository, current.base, current.candidate), deliveryId, current, options);
    if (ancestor.unknown) return ancestor.value;
    // Fast-forward-only integration makes the independently verified candidate the exact final commit/tree.
    transition(deliveryId, current, { status: 'applying', target, actor: 'root' }, options);
    hook('beforeGit');
    const applying = mustRead(deliveryId);
    const moved = await readback(reader.updateRef(reader.repository, target, current.candidate, current.base), deliveryId, applying, options);
    if (moved.unknown) return moved.value;
    hook('afterGit');
    return reconcile(taskId, options);
  }

  async function adjudicate(taskId, evidence, actor = 'operator', options = {}) {
    const deliveryId = 'delivery:' + taskId;
    if (actor !== 'operator' || !evidence) fail('DENIED');
    const current = mustRead(deliveryId);
    if (current.status !== 'unknown') fail('NOT_UNKNOWN');
    const actual = await readback(reader.revParse(reader.repository, current.target), deliveryId, current, options);
    if (actual.unknown) return actual.value;
    if (actual.value === current.candidate) return reconcile(taskId, options);
    if (actual.value !== current.base) fail('REBUILD_REQUIRED');
    const dirty = await readback(reader.dirty(current.directory), deliveryId, current, options);
    if (dirty.unknown) return dirty.value;
    if ((dirty.value ?? '') !== '') fail('REBUILD_REQUIRED');
    return transition(deliveryId, current, { status: 'verified', adjudication: evidence, actor: 'operator' }, options);
  }

  async function reconcile(taskId, options = {}) {
    const deliveryId = 'delivery:' + taskId;
    const current = mustRead(deliveryId);
    if (!current.target) fail('MISSING_REFERENCE');
    const actual = await readback(reader.revParse(reader.repository, current.target), deliveryId, current, options);
    if (actual.unknown) return actual.value;
    const tree = await readback(reader.tree(reader.repository, actual.value), deliveryId, current, options);
    if (tree.unknown) return tree.value;
    const task = core.store.read(taskId);
    const contractCurrent = Boolean(task) && digest({ scopeSet: task.scopeSet, contractRevision: task.contractRevision,
      approved: task.approved }) === current.certificate?.contractHash;
    if (contractCurrent && actual.value === current.candidate && tree.value === current.tree) {
      return transition(deliveryId, current, { status: 'accepted', integrationCommit: actual.value,
        integrationTree: current.tree, actor: 'root' }, options);
    }
    return transition(deliveryId, current, { status: 'unknown',
      reason: 'target or contract does not match certified integration', responsible: 'operator',
      lastEvidence: { actual: actual.value, contractCurrent }, nextReviewAt: now() + REVIEW_MS, actor: 'root' }, options);
  }

  /** The cold-start readback: every delivery left applying gets its evidence re-read; §3.8. */
  async function reconcileApplying({ signal = null, options = {} } = {}) {
    const rows = core.store.list('delivery:').filter(row => row.status === 'applying' && !core.store.effects().some(effect => effect.payload?.kind === 'delivery' && effect.payload.deliveryId === row.entityId && ['pending', 'retryable'].includes(effect.status)));
    const report = { inspected: rows.length, accepted: 0, unknown: 0, skipped: 0, errors: [] };
    options = { ...options, ...(access ? { route: access.deliveryRecovery() } : {}) };
    for (const row of rows) {
      if (signal?.aborted) {
        report.skipped += 1;
        continue;
      }
      try {
        const result = await reconcile(row.taskId ?? String(row.entityId).replace(/^delivery:/, ''), options);
        if (result?.status === 'accepted') report.accepted += 1;
        else if (result?.status === 'unknown') report.unknown += 1;
      } catch (error) {
        report.errors.push({ deliveryId: row.entityId, code: error?.code ?? 'ERROR' });
      }
    }
    return Object.freeze({ ...report, status: report.errors.length || report.skipped ? 'unknown' : 'ok', errors: Object.freeze(report.errors) });
  }

  return Object.freeze({ port: reader, repository: reader.repository, worktree, produce, verify, integrate, adjudicate, reconcile, reconcileApplying });
}
