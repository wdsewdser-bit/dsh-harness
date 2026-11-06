import { failWith } from '../../contracts/index.mjs';
import { createProcessTree, descendantPids } from './win/process-tree.mjs';

/**
 * D2b / §10 P5 (docs/decisions/team-autonomy-design.md §7.2.1-§7.2.3, §7.3): the stop proof.
 *
 * The proof is a predicate over the operating system, not over a caller's word: every process that belonged to the
 * session tree is gone — matched by `pid + creation time`, so a pid that was reused by an unrelated process is not
 * mistaken for the one that died — and the tree stayed empty for several consecutive polls. The two budgets of §7.2.3
 * are the only clock this file uses: `graceMs` for the graceful stop, `proofTimeoutMs` for the readback afterwards.
 *
 * Nothing in here writes to the control store or awaits inside a transaction: the row is returned, and the caller
 * commits it in the same transaction as the member/attempt transition it justifies (§7.2.5). A caller that cannot get
 * `verified === true` gets a row that says so — and the design forbids turning that into "stopped" (§7.2.3 rule 2).
 */

export const STOP_PROOF_KIND = 'stop-proof';
/** §7.2.1's row id, plus an attempt counter so a retry keeps the earlier evidence instead of overwriting it. */
export const stopProofId = (subject, seq = 1) => 'stop-proof:' + subject.id + ':' + subject.fence + ':' + seq;

const defaultSleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const SUBJECT_KINDS = Object.freeze(['attempt', 'member-session', 'session', 'effect']);

function normalizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    failWith('INVALID_CONFIG', 'a stop proof needs at least one root process; got ' + JSON.stringify(roots ?? null));
  }
  return roots.map(entry => {
    const pid = entry?.pid;
    const createdAt = entry?.createdAt;
    if (!Number.isSafeInteger(pid) || pid <= 0 || createdAt === undefined || createdAt === null || createdAt === '') {
      failWith('INVALID_CONFIG', 'a root process needs a pid and its creation time; got ' + JSON.stringify(entry ?? null));
    }
    return { pid, createdAt: String(createdAt), image: entry.image ?? null };
  });
}

/**
 * Build the prover. Everything it touches is injectable so the unit tests drive the production code path: `tree` is
 * the platform port, `now`/`sleep` are the clock, and `pollMs`/`stablePolls` are the readback discipline of §7.2.3
 * ("three consecutive empty polls"), not a configuration knob of the product.
 */
export function createStopProver({ tree = createProcessTree(), now = () => Date.now(), sleep = defaultSleep,
  pollMs = 200, stablePolls = 3 } = {}) {
  if (typeof tree?.list !== 'function' || typeof tree?.killTree !== 'function') {
    failWith('INVALID_CONFIG', 'a stop prover needs a process-tree port');
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 0 || !Number.isSafeInteger(stablePolls) || stablePolls < 1) {
    failWith('INVALID_CONFIG', 'pollMs must be a non-negative integer and stablePolls at least 1');
  }

  async function prove({ subject, roots, graceMs = 5000, proofTimeoutMs = 10000, requestStop = null } = {}) {
    if (!subject || typeof subject.id !== 'string' || !subject.id || !Number.isSafeInteger(subject.fence) ||
      !SUBJECT_KINDS.includes(subject.kind)) {
      failWith('INVALID_CONFIG', 'a stop proof names its subject (kind ' + SUBJECT_KINDS.join('/') + ', id, fence)');
    }
    const rootList = normalizeRoots(roots);
    const row = { kind: STOP_PROOF_KIND, subject: { kind: subject.kind, id: subject.id, fence: subject.fence },
      method: tree.method ?? 'taskkill-tree', roots: rootList, reaped: [], descendantsAfter: null, polls: 0,
      emptySince: null, verified: false, confidence: 'low', at: now(), tool: null, error: null };
    if (typeof tree.available === 'function' && tree.available() !== true) {
      row.method = 'none';
      row.error = { code: 'STOP_CAPABILITY_MISSING', message: 'platform ' + String(tree.platform) +
        ' has no process-tree implementation, so no process stop can be proven here' };
      return row;
    }
    // The identity of everything this proof is about: the roots plus every descendant seen while they were alive.
    // Tracking by (pid, createdAt) is what makes an orphan visible after its parent dies, and what makes a reused pid
    // untouchable: a pid whose creation time moved is a different process and is never killed (§7.2.3 rule 1).
    const tracked = new Map(rootList.map(root => [root.pid, root.createdAt]));
    const maxPolls = Math.ceil((Math.max(0, graceMs) + Math.max(1, proofTimeoutMs)) / Math.max(1, pollMs)) + 100;
    let polls = 0;
    const readAlive = async snapshot => {
      const byPid = new Map(snapshot.map(entry => [entry.pid, entry]));
      const alive = [];
      for (const [pid, createdAt] of tracked) {
        const entry = byPid.get(pid);
        if (entry && entry.createdAt === createdAt) alive.push({ pid, createdAt, image: entry.name ?? null });
      }
      return alive;
    };
    const rememberTree = snapshot => {
      for (const [pid, createdAt] of [...tracked]) {
        const root = { pid, createdAt };
        const self = snapshot.find(entry => entry.pid === root.pid);
        // Only a root that is still the same process can lend its children to this tree; a reused pid's children are
        // somebody else's processes.
        if (!self || self.createdAt !== root.createdAt) continue;
        for (const pid of descendantPids(snapshot, root.pid)) {
          if (tracked.has(pid)) continue;
          const entry = snapshot.find(candidate => candidate.pid === pid);
          if (entry) tracked.set(pid, entry.createdAt);
        }
      }
    };

    try {
      // Capture scope BEFORE requestStop can orphan/reparent descendants.
      const initial = await tree.list();
      polls++;
      if (!rootList.every(root => initial.some(p => p.pid === root.pid && p.createdAt === root.createdAt))) {
        row.error = { code: 'STOP_SCOPE_UNPROVEN', message: 'root identity absent before tree capture; descendant scope is unknown' };
        row.polls = polls;
        return row;
      }
      rememberTree(initial);
      // Stage one (§7.2.3): the graceful stop, then the grace period. A port that already stopped the session makes
      // this the whole proof; a port that did not leaves the tree alive and the second stage takes over.
      if (typeof requestStop === 'function') {
        try { await requestStop(); } catch (error) {
          row.error = { code: error?.code ?? 'STOP_NOT_VERIFIED',
            message: 'the graceful stop request failed: ' + String(error?.message ?? error) };
        }
      }
      const graceDeadline = now() + Math.max(0, graceMs);
      let live = [];
      for (;;) {
        const snapshot = await tree.list();
        polls += 1;
        rememberTree(snapshot);
        live = await readAlive(snapshot);
        if (!live.length) {
          row.verified = false; row.stopState='unverified'; row.error={code:'STOP_SCOPE_UNPROVEN',message:'PID tree samples are diagnostics, not complete execution containment'};
          row.confidence = 'low';
          row.descendantsAfter = 0;
          row.emptySince = now();
          row.polls = polls;
          return row;
        }
        if (now() >= graceDeadline || polls > maxPolls) break;
        await sleep(Math.max(0, Math.min(pollMs, graceDeadline - now())));
      }

      // Stage two (§7.2.3): the hard kill. PID reuse is checked against the snapshot taken by THIS poll, immediately
      // before each kill, and a mismatched pid is skipped rather than killed.
      const reused = [];
      const denied = [];
      const snapshot = await tree.list();
      polls += 1;
      rememberTree(snapshot);
      // Every tracked pid that still EXISTS is either ours (identity matches) or a pid somebody else reused. The second
      // kind is what `PID_REUSED` is about: it is recorded, and it is never handed to a kill (§7.2.3 rule 1).
      const present = [...tracked.keys()].filter(pid => snapshot.some(candidate => candidate.pid === pid));
      for (const pid of present) {
        const entry = { pid, createdAt: tracked.get(pid) };
        const current = snapshot.find(candidate => candidate.pid === pid);
        if (!current || current.createdAt !== entry.createdAt) { reused.push(entry.pid); continue; }
        let outcome;
        try {
          outcome = await tree.killTree(entry.pid);
        } catch (error) {
          outcome = { ok: false, code: error?.code ?? 'STOP_NOT_VERIFIED', message: String(error?.message ?? error) };
        }
        row.reaped.push({ pid: entry.pid, exitCode: null, at: now() });
        if (outcome && outcome.ok !== true) {
          if (outcome.code === 'STOP_ACCESS_DENIED') denied.push(entry.pid);
          row.error = { code: outcome.code ?? 'STOP_NOT_VERIFIED', message: outcome.message ?? null };
        }
      }
      row.tool = typeof tree.lastTool === 'function' ? tree.lastTool() : null;
      if (reused.length) row.pidReused = reused.slice();

      // Stage three: the readback. Three consecutive empty polls, within the second budget, or no proof.
      const proofDeadline = now() + Math.max(1, proofTimeoutMs);
      let streak = 0;
      let remaining = [];
      for (;;) {
        const after = await tree.list();
        polls += 1;
        rememberTree(after);
        remaining = await readAlive(after);
        if (!remaining.length) {
          streak += 1;
          if (streak >= stablePolls) { row.verified = false; row.stopState='unverified'; row.error={code:'STOP_SCOPE_UNPROVEN',message:'PID tree samples are diagnostics, not complete execution containment'}; break; }
        } else {
          streak = 0;
        }
        if (now() >= proofDeadline || polls > maxPolls) break;
        await sleep(pollMs);
      }
      row.polls = polls;
      row.descendantsAfter = remaining.length;
      if (row.verified) {
        row.confidence = 'high';
        row.emptySince = now();
        row.error = null;
      } else {
        row.confidence = 'low';
        if (reused.length) {
          row.error = { code: 'PID_REUSED', message: 'pid(s) ' + reused.join(', ') +
            ' belong to another process now and were not killed; the tree cannot be proven stopped' };
        } else if (denied.length) {
          row.error = { code: 'STOP_ACCESS_DENIED', message: 'access denied killing pid(s) ' + denied.join(', ') };
        } else if (!remaining.length) {
          row.error = {code:'STOP_SCOPE_UNPROVEN',message:'empty PID tree is diagnostic only; coverage is incomplete'};
        } else {
          row.error = { code: 'STOP_PROOF_TIMEOUT', message: remaining.length + ' process(es) of this tree were still ' +
            'alive after ' + proofTimeoutMs + 'ms; no stop is proven' };
        }
      }
      return row;
    } catch (error) {
      row.verified = false;
      row.confidence = 'low';
      row.polls = polls;
      row.error = { code: error?.code ?? 'STOP_NOT_VERIFIED', message: String(error?.message ?? error) };
      return row;
    }
  }

  return Object.freeze({ prove, tree: () => tree });
}
