import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';

export const ROOT = 'member:root', WORKER = 'member:a';
export function realTeam(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-review-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team-x', subCoordinatorMinWorkers: 1, ...options });
  core.member(ROOT, 'root'); core.member(WORKER, 'worker'); core.member('member:b', 'worker');
  core.member('member:coord', 'subCoordinator');
  const put = (id, row) => core.mutate(id, 'root', { seed: row }, tx => tx.put(id, row));
  return { dir, store, core, put, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
