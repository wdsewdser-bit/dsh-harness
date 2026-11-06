import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost } from '../index.mjs';
import {closeRealFixture} from './cleanup.mjs';
export async function real(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-b-'));
  const store = new ControlStore(root);
  let at = Date.now();
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:b', now: () => at });
  const host = createTeamHost({ root, teamId: 'team:b', core, now: () => at, cycleIntervalMs: 1000000,
    recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }), ...options });
  await host.start();
  let cleanup=null,originalError=null;
  return { root,core, store, host,recordError(error){originalError??=error;},get at() { return at; }, set at(v) { at = v; },
    snapshot: () => JSON.stringify({ rows: store.list(), events: store.events(), effects: store.effects() }),
    async close(options={}) {return cleanup??=(closeRealFixture({root,host,store,error:originalError,expectIsolated:options.expectIsolated===true}));} };
}
