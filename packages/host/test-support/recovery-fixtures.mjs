import test from 'node:test';
import { profile } from '../test-support/profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { GoalGate, RECOVERY_CONTRACT, TeamCore, canonical, createRecoveryScope, digest, recoverFacts } from '../../core/index.mjs';
import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTeamHost } from '../index.mjs';
import { createGoalRecovery } from '../src/goal.mjs';
import { createRecovery } from '../src/recover.mjs';
import { createHostDelivery } from '../src/delivery.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { openSessionLog } from '../../adapter-dsh/index.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';

/**
 * The E package's recovery suite: design §3.5.1, §3.8 and the fault rows F3, F8 (seven sub-cases), F23, F24.
 *
 * Every case drives the real composition - ControlStore, TeamCore, TeamHost, the host's controlled write ports - and
 * seeds durable rows, never only a token or an attempt: a task that is executing, a pending wait, an applying
 * member-intent, an active attempt and an unresolved completion token. The recovery pass is the host's own recoverer,
 * so "start succeeded", "status is readable" and "admission is what the conclusion says" are asserted where they are
 * decided, not on a hand-built object.
 */

export const GOAL = Object.freeze({ id: 'goal:one', revision: 1, objective: 'deliver', maxGoalRounds: 5 });

export function seed(core, at, { token = null, sessionId = 'session:e', attempt = true } = {}) {
  core.member('member:w', 'worker');
  core.task('task:a', 'member:w');
  if (!attempt) return { sessionId, attempt: null };
  const admitted = core.schedule('admit:a', 'task:a', at).result;
  core.mutate('wait:a', 'scheduler', {}, tx => {
    tx.put('wait:a', { status: 'pending', attemptId: admitted.attemptId, taskId: 'task:a' });
    tx.put('member-intent:a', { status: 'applying', memberRef: 'member:w' });
    if (token) tx.put('completion:' + token.name, { ...token.row, input: { sessionId, goal: token.goal ?? GOAL } });
    return null;
  });
  return { sessionId, attempt: admitted };
}

/**
 * One team directory that can be started, stopped and started again (a restart is a new host and a new epoch). The
 * journal port is per-instance so a case can answer it differently on the second start.
 */
export async function rig({ token = null, journal = () => null, delivery = null, attempt = true, readTimeoutMs = 1000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-rec-'));
  const at = Date.now();
  const state = { root, at, store: null, core: null, host: null, recovery: null, goal: null, port: journal, delivery,
    readTimeoutMs, seeded: null, epoch: null };
  const open = () => {
    state.store = new ControlStore(state.root);
    state.core = new TeamCore(state.store, {}, { enabled: true, attach: true, teamId: 'team:e', now: () => state.at });
    return state.core;
  };
  const build = () => {
    state.goal = createGoalRecovery({ core: state.core, sessionLog: options => state.port(options), readTimeoutMs: state.readTimeoutMs });
    state.recovery = createRecovery({ core: state.core, access: state.host.coreAccess, goal: state.goal, delivery: state.delivery });
    return state.host;
  };
  const makeHost = () => {
    state.host = createTeamHost({ root: state.root, teamId: 'team:e', core: state.core, now: () => state.at,
      cycleIntervalMs: 1000000, openStore: () => ({ close() {} }),
      recoverer: context => state.recovery.recover(context) });
    return state.host;
  };
  open();
  state.seeded = seed(state.core, at, { token, attempt });
  makeHost();
  build();
  return {
    state,
    get core() { return state.core; },
    get store() { return state.store; },
    get host() { return state.host; },
    get recovery() { return state.recovery; },
    get goal() { return state.goal; },
    get at() { return state.at; },
    async start() { await state.host.start(); state.epoch = state.host.status().epoch; return state.host.status(); },
    async restart() {
      await state.host.stop({ timeoutMs: 2000 });
      state.store.close();
      open();
      makeHost();
      build();
      await state.host.start();
      return state.host.status();
    },
    async close() {
      try { await state.host.stop({ timeoutMs: 2000 }); } catch { /* already stopped */ }
      try { state.store.close(); } catch { /* already closed */ }
      fs.rmSync(state.root, { recursive: true, force: true });
    },
  };
}

export const cancelled = (w) => w.store.effects().filter(effect => effect.payload?.kind === 'cancel' && effect.id.startsWith('recover-cancel:'));

