import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamScope } from '../src/scope.mjs';
import { createUiStore } from '../src/store.mjs';
import { scenarioDefault, withPanelBlocks, MOCK_VIEWER } from '../src/mock.mjs';
import { installReact, wire, buttons, textOf, NOW } from '../test-support/v3-tree.mjs';
import { commandAdmission, viewerReadOnly } from '../src/authority.mjs';
installReact();
const { TEAM, TeamPage, commandFor, CommandPalette } = await import('../src/ui.mjs');
const { MemberActions } = await import('../src/ui/detail.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const data = () => withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW);
const env = () => ({ teamId: 'team:mock', schemaVersion: 1, asOfSeq: 1, viewer: MOCK_VIEWER, data: data() });

test('root panel metadata and allowed capabilities cannot lend authority to unknown, readonly or foreign principals', () => {
  const panel = data(), target = panel.members.find(m => m.id === 'member:worker-a');
  target.capabilities = Object.fromEntries(['mailbox.send', 'organization.requestFreeze', 'organization.retire']
    .map(name => [name, { allowed: true }]));
  assert.equal(panel.viewerRole, 'root');
  for (const viewer of ['member:missing', 'viewer:readonly', { teamId: 'team:mock', memberId: 'member:missing' },
    { teamId: 'other-team', memberId: MOCK_VIEWER }, { memberId: MOCK_VIEWER },
    { teamId: 'team:mock', memberId: 'operator' },
    { teamId: 'team:mock', memberId: 'viewer:readonly' }]) {
    const ui = wire(TEAM, panel, viewer);
    assert.equal(viewerReadOnly(panel, viewer), true, JSON.stringify(viewer));
    assert.ok(commandAdmission({ name: 'mailbox.send', target: target.id }, panel, viewer));
    assert.doesNotMatch(buttons(MemberActions({ data: panel, now: NOW, id: target.id, onOpen() {} })).map(textOf).join(' '),
      /发话|冻结|退役/);
    ui.openPalette(commandFor('send', target, panel, MOCK_VIEWER));
    assert.equal(CommandPalette(), null);
  }
  assert.equal(commandAdmission({ name: 'mailbox.send', target: target.id }, panel,
    { teamId: 'team:mock', memberId: MOCK_VIEWER }), null, 'confirmed local root remains a positive case');
  assert.equal(commandAdmission({ name: 'mailbox.send', target: target.id }, panel, 'operator'), null);
  panel.viewerRole = 'viewer';
  assert.ok(commandAdmission({ name: 'mailbox.send', target: target.id }, panel, MOCK_VIEWER), 'explicit readonly wins');
  assert.equal(viewerReadOnly(panel, MOCK_VIEWER), true);
});

test('binding failure is not a cached no-team result; the production error-page retry calls resync(manual)', async () => {
  const ui = createUiStore(null, null); let calls = 0;
  const scope = new TeamScope({ ui, createSource: () => ({ source: { describe: () => ({}),
    binding: async () => { if (++calls === 1) throw Error('HTTP 503 TEMPORARY'); return { teamId: 'team:mock' }; },
    snapshot: async () => env(), subscribe: () => () => {} } }) });
  try {
    await scope.switchSession('A');
    assert.equal(scope.getSnapshot().status, 'error'); assert.equal(scope.getSnapshot().binding, undefined);
    Object.assign(TEAM, { client: scope, scope, ui });
    const errorPage = TeamPage({ sessionId: 'A' });
    assert.match(textOf(errorPage), /HTTP 503 TEMPORARY/);
    assert.doesNotMatch(textOf(errorPage), /这个会话没有团队|s 后重试/);
    const retry = buttons(errorPage).find(button => textOf(button) === '重试');
    assert.ok(retry, 'recovery is available in the real error page');
    const resync = scope.resync.bind(scope); let reason;
    scope.resync = value => { reason = value; return resync(value); };
    await retry.props.onClick();
    assert.equal(reason, 'manual'); assert.equal(calls, 2);
    assert.equal(scope.getSnapshot().status, 'ready'); assert.ok(scope.getSnapshot().data);
  } finally { scope.stop(); TEAM.scope = null; }
});

test('confirmed no-team results cache, but a repeated failed binding request is retriable', async () => {
  let calls = 0;
  const scope = new TeamScope({ ui: createUiStore(null, null), createSource: () => ({ source: { describe: () => ({}),
    binding: async sid => { calls++; if (sid === 'bad') throw Error('temporary'); return null; } } }) });
  try {
    await scope.switchSession('none'); await scope.switchSession('none'); assert.equal(calls, 1);
    assert.equal(scope.getSnapshot().binding, null); assert.equal(scope.getSnapshot().status, 'ready');
    await scope.switchSession('bad'); await scope.switchSession('bad'); assert.equal(calls, 3);
    assert.equal(scope.getSnapshot().binding, undefined);
  } finally { scope.stop(); }
});

for (const stage of ['binding', 'snapshot', 'ready']) for (const fails of [false, true]) {
  test('production stop/start always rebuilds after ' + stage + (fails ? ' (late rejection)' : ' (late success)'), async () => {
    const oldBinding = deferred(), oldSnapshot = deferred(), ui = createUiStore(null, null);
    ui.set({ frameSession: 'A' }); let bindings = 0, snapshots = 0, closed = 0;
    const scope = new TeamScope({ ui, createSource: () => ({ source: { describe: () => ({}),
      binding: () => ++bindings === 1 && stage === 'binding' ? oldBinding.promise : Promise.resolve({ teamId: 'team:mock' }),
      snapshot: () => ++snapshots === 1 && stage === 'snapshot' ? oldSnapshot.promise : Promise.resolve(env()),
      subscribe: () => () => { closed++; } } }) });
    try {
      const previous = scope.start(); await Promise.resolve(); await Promise.resolve();
      if (stage === 'ready') await previous;
      const generation = scope.generation;
      scope.stop();
      assert.equal(scope.pending, null); assert.equal(scope.unlisten, null); assert.equal(scope.client, null);
      assert.equal(scope.getSnapshot().binding, undefined); assert.equal(scope.getSnapshot().data, null);
      const restarted = scope.start(); assert.notEqual(restarted, previous);
      await restarted;
      assert.equal(bindings, 2); assert.ok(scope.generation > generation);
      assert.equal(snapshots, stage === 'binding' ? 1 : 2);
      assert.equal(scope.getSnapshot().status, 'ready'); assert.ok(scope.client);
      const current = scope.getSnapshot();
      const late = stage === 'binding' ? oldBinding : oldSnapshot;
      if (fails) late.reject(Error('stopped work failed')); else late.resolve(stage === 'binding' ? { teamId: 'other' } : env());
      if (stage === 'ready') late.promise.catch(() => {});
      await previous;
      assert.equal(scope.getSnapshot(), current, 'stopped work cannot clear or overwrite the restarted scope');
      assert.equal(closed, stage === 'ready' ? 1 : 0);
    } finally { scope.stop(); }
  });
}
