import test from 'node:test';
import assert from 'node:assert/strict';
import { load, loadBuild } from '../../adapter-dsh/index.mjs';
import { mainRequestPredicate } from '../../profiles/index.mjs';

/**
 * F2b regression: the main-request predicate must be the module instance the Loader boots.
 *
 * dsh-llm records the requests its agent loop assembles in a module-level WeakSet, so the answer is a property of the
 * *instance*, not of the release: the pristine copy ships the same code and answers false for the build's own requests.
 * The visibility layer's whole injection path hangs off this predicate (isMain), which is how the defect surfaced: the
 * host woke an agent into a turn and the turn died on ctx.llm.isAgentLoopRequest being undefined.
 */
test('the main-request predicate reads the module instance the agent loop uses', async () => {
  const build = await loadBuild('dsh-llm');
  const pristine = await load('dsh-llm');
  assert.notEqual(build, pristine, 'the build and the pristine install are two module instances');
  const marked = build.markAgentLoopRequest({});
  assert.equal(build.isAgentLoopRequest(marked), true);
  assert.equal(pristine.isAgentLoopRequest(marked), false, 'the pristine predicate cannot see the build marks');
  const isMain = await mainRequestPredicate();
  assert.equal(isMain(marked), true, 'a request the running agent loop assembled is a main request');
  assert.equal(isMain({}), false, 'an unmarked request is not a main request');
  assert.equal(isMain(undefined), false, 'a missing request is never main');
});
