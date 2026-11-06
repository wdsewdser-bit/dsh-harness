import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioDefault, withPanelBlocks, MOCK_VIEWER } from '../src/mock.mjs';
import { installReact, wire, nodes, buttons, textOf, NOW } from '../test-support/v3-tree.mjs';
import { commandAdmission } from '../src/authority.mjs';
installReact();
const { TEAM, commandFor, readOnlyViewer, CommandPalette } = await import('../src/ui.mjs');
const { MemberActions } = await import('../src/ui/detail.mjs');
const commands = ['mailbox.send', 'organization.requestFreeze', 'organization.requestResume', 'organization.retire'];
const actions = data => MemberActions({ data, now: NOW, id: 'member:worker-a', onOpen() {} });

test('actual root/member/viewer principals and authoritative capabilities gate every member write', () => {
  for (const [id, role] of [[MOCK_VIEWER, 'root'], ['member:worker-a', 'worker'], ['viewer:readonly', 'viewer'], ['member:missing', 'unknown']]) {
    const data = withPanelBlocks(scenarioDefault(NOW), id, NOW);
    data.viewerRole = role;
    const target = data.members.find(m => m.id === 'member:worker-a');
    target.capabilities = Object.fromEntries(commands.map(name => [name, { allowed: false, reasonText: '服务端拒绝' }]));
    const principal = { teamId: 'team:mock', memberId: id };
    wire(TEAM, data, principal);
    assert.equal(buttons(actions(data)).some(n => /发话|冻结|恢复|退役/.test(textOf(n))), false, id);
    if (role === 'root') assert.ok(nodes(actions(data)).some(n => n.props?.['data-capability-refusal']), 'refusal reason stays visible');
    if (role !== 'root') assert.equal(readOnlyViewer(data, principal), true);
    for (const name of commands) target.capabilities[name] = { allowed: true };
    wire(TEAM, data, principal);
    const labels = buttons(actions(data)).map(textOf).join(' ');
    if (role === 'root') { assert.match(labels, /发话/); assert.match(labels, /冻结/); assert.match(labels, /退役/); }
    else assert.doesNotMatch(labels, /发话|冻结|恢复|退役/);
  }
});

test('palette and captured submit admission are invalidated by principal, capability or scope changes', () => {
  const data = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW), member = data.members.find(m => m.id === 'member:worker-a');
  member.capabilities = { 'mailbox.send': { allowed: true } };
  const ui = wire(TEAM, data, { teamId: 'team:mock', memberId: MOCK_VIEWER });
  TEAM.scope = { generation: 10 };
  const cmd = commandFor('send', member, data);
  assert.equal(commandAdmission(cmd, data, MOCK_VIEWER, 10), null);
  ui.openPalette(cmd);
  member.capabilities['mailbox.send'] = { allowed: false, reasonText: '完成检查期间禁止修改' };
  assert.equal(CommandPalette(), null);
  assert.match(commandAdmission(cmd, data, MOCK_VIEWER, 10), /完成检查/);
  member.capabilities['mailbox.send'] = { allowed: true };
  assert.match(commandAdmission(cmd, data, { teamId: 'team:mock', memberId: 'member:worker-a' }, 10), /身份已变化/);
  assert.match(commandAdmission(cmd, data, MOCK_VIEWER, 11), /会话已切换/);
  assert.ok(commandAdmission(cmd, { ...data, viewerRole: 'viewer' }, 'viewer:readonly', 10));
  TEAM.scope = null;
});

test('mock startup config and URL pass viewer and fixture through the official source selector, never override HTTP auth', async () => {
  const { createTeamSource } = await import('../src/plugin.mjs');
  const before = globalThis.location;
  try {
    globalThis.location = { search: '?teamFixture=long-text&teamViewer=viewer:readonly' };
    const picked = createTeamSource({ source: 'mock' });
    const envelope = await picked.source.snapshot();
    assert.equal(envelope.viewer, 'viewer:readonly');
    assert.equal(envelope.data.viewerRole, 'viewer');
    assert.match(envelope.data.tasks.find(t => t.id === 'task-12').title, /跨组适配方案/);
    globalThis.location = { search: '' };
    const configured = createTeamSource({ source: 'mock', viewer: 'viewer:custom', fixture: 'intent' });
    assert.equal(configured.source.describe().viewer, 'viewer:custom');
    assert.match(configured.source.describe().label, /intent/);
    globalThis.location = { search: '?teamViewer=operator' };
    const real = createTeamSource({ source: 'http', base: 'http://127.0.0.1:1', token: 't', viewer: 'member:root' });
    assert.equal(real.source.describe().viewer, 'member:root');
  } finally { globalThis.location = before; }
});
