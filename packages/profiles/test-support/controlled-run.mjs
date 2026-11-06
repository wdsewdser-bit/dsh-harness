import { cleanupOrThrow } from './temp-roots.mjs';
import { runProcessTree } from './process-tree.mjs';

/**
 * One controlled candidate run. Cleanup is called only after the launcher has confirmed that the root and every
 * identity-checked descendant are gone. A terminated:false result is a hard failure and retains the caller's temp root.
 */
export async function runControlled({ tempRoot, cleanup = cleanupOrThrow, spawnTree = runProcessTree, ...options } = {}) {
  const result = await spawnTree(options);
  if (result.terminated !== true) {
    const error = Object.assign(Error('终止未确认: ' + (result.failure ?? 'the controlled process tree did not drain')),
      { code: 'TERMINATION_UNCONFIRMED', processResult: result });
    throw error;
  }
  cleanup([tempRoot]);
  return result;
}