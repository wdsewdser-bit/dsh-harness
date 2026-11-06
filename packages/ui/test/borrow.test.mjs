// P5 client acceptance: the v1 read states are consumed, never invented; the UI offers only permitted actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createUiStore } from '../src/store.mjs';
import { scenarioBorrow, scenarioDefault, createMockSource, MOCK_VIEWER, withPanelBlocks, mockActivity } from '../src/mock.mjs';
import { borrowAttention, capacityView, inputsView, laneText, needsYou, resourceThreadsOf, roleGuardView } from '../src/model.mjs';
import { applyEvent, ProjectionClient } from '../src/projection.mjs';
import { nodes, textOf } from '../test-support/v3-tree.mjs';

globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: Symbol('Fragment'), useState: value => [
  typeof value === 'function' ? value() : value, () => {}], useEffect: () => {},
  useRef: value => ({ current: value }), useSyncExternalStore: (_sub, get) => get.name === 'get' ? NOW : get(), useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };
const { commandFor, resourceActions, Detail } = await import('../src/ui.mjs');
const { RecordsPage } = await import('../src/ui/records.mjs');

const NOW = Date.UTC(2026, 10, 2, 12, 0);
// Independent fixture display expectations: do not generate these with the production normalizer.
const TASK_WORDING = { 'task-9': '验收 帧图依赖排序', 'task-21': '最终验收：集成分支' };
const MESSAGE_WORDING = { 'msg-90': '提供 的基准复现脚本', 'msg-96': '验收 交付 r1', 'msg-98': '拆分 ，控制上下文' };
const waitFor = async (predicate, label) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) throw Error('timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

// The baseline is the last commit before the WP-B directory rename (team-core/control-store/dsh-adapter/client-team ->
// core/store/adapter-dsh/ui). It is pinned by sha, not by HEAD: once WP-B is committed, HEAD no longer carries the
// package this test reads the legacy tabs from.
const BASELINE = '06777c9';

test('P5 review: the off L2 pane still renders identically to the pinned pre-rename baseline, and the page keeps its members', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-ui-head-'));
  try {
    for (const file of ['ui', 'model', 'projection']) {
      const result = spawnSync('git', ['show', BASELINE + ':packages/client-team/src/' + file + '.mjs'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      fs.writeFileSync(path.join(dir, file + '.mjs'), result.stdout);
    }
    const baseline = await import(pathToFileURL(path.join(dir, 'ui.mjs')).href);
    const current = await import('../src/ui.mjs');
    const render = node => {
      if (node == null || typeof node === 'boolean') return [];
      if (Array.isArray(node)) return node.flatMap(render);
      if (typeof node !== 'object') return [String(node)];
      if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
      if (node.type === React.Fragment) return render(node.children);
      const props = Object.fromEntries(Object.entries(node.props ?? {}).filter(([key, value]) => key !== 'key' && key !== 'ref' &&
        typeof value !== 'function'));
      return [{ type: node.type, props, children: render(node.children) }];
    };
    const elementsOf = tree => tree.flatMap(node => typeof node === 'string' ? [] : [node, ...elementsOf(node.children ?? [])]);
    const rowsOf = tree => elementsOf(tree).map(node => node.props?.['data-member']).filter(Boolean);
    const textsOf = tree => tree.flatMap(node => [typeof node === 'string' ? node : null, ...textsOf(node.children ?? [])])
      .filter(Boolean);
    const data = scenarioDefault(NOW);
    const clientFor = viewer => ({ subscribe: () => () => {}, getSnapshot: () => ({ data, viewer, status: 'live', asOfSeq: 100,
      sourceRevisions: {}, sourceKind: 'mock', lastEventAt: NOW, lastSnapshotAt: NOW }) });
    for (const viewer of [MOCK_VIEWER, 'member:root', 'member:nobody']) {
      // R-1 protects the whole old page, not just L2. Keep the full L2 matrix, with only the explicitly denied
      // unknown-principal command controls removed from the expected tree; all facts/props remain exact.
      for (const tab of ['member', 'task', 'thread', 'message', 'context']) {
        const ui = createUiStore({ storage: null, tabStorage: null }); ui.setTab(tab);
        const client = clientFor(viewer);
        for (const module of [baseline, current]) Object.assign(module.TEAM, { client, ui, nav: {}, gateway: null });
        const legacy = render(baseline.Detail({ data, now: NOW, ui: ui.getSnapshot(), onOpen: () => {} }));
        const permittedLegacy = tree => tree.flatMap(node => {
          if (typeof node === 'string') return [node];
          const label = textsOf(node.children ?? []).join('');
          if (viewer === 'member:nobody' && node.type === 'button' &&
              ['以 owner 身份决定…', '升级 / 转交…', '取消…', '改投…'].includes(label)) {
            assert.equal(node.props.disabled, true, 'the legacy unknown-principal control was never an authorized write');
            return [];
          }
          return [{ ...node, children: permittedLegacy(node.children ?? []) }];
        });
        assert.deepEqual(render(current.Detail({ data, now: NOW, ui: ui.getSnapshot(), onOpen: () => {} })),
          permittedLegacy(legacy), viewer + '/' + tab);
        if (viewer === 'member:nobody') assert.equal(elementsOf(render(current.Detail({ data, now: NOW,
          ui: ui.getSnapshot(), onOpen() {} }))).some(n => n.type === 'button' && /决定…|转交…|取消…|改投…/.test(textsOf(n.children).join(''))),
        false, 'unknown principals have no write controls');
      }
      // R-1: explicitly select EVERY member, not just root or the context top six. Compare all non-action facts.
      const facts = tree => tree.flatMap(node => {
        if (typeof node === 'string') return [node];
        if (node.props?.className === 'tm-actions' || node.props?.['data-readonly'] === 'actions') return [];
        return [{ ...node, children: facts(node.children ?? []) }];
      });
      assert.ok(data.members.some(member => member.context == null), 'the matrix really includes unknown context');
      for (const member of data.members) for (const tab of ['member', 'context']) {
        const selectedUi = createUiStore(null, null);
        selectedUi.set({ selected: member.id, detail: { tab, id: member.id } });
        for (const module of [baseline, current]) Object.assign(module.TEAM, { client: clientFor(viewer), ui: selectedUi, nav: {} });
        const currentFacts = facts(render(current.Detail({ data, now: NOW, ui: selectedUi.getSnapshot(), onOpen() {} })));
        const baselineFacts = facts(render(baseline.Detail({ data, now: NOW, ui: selectedUi.getSnapshot(), onOpen() {} })));
        assert.deepEqual(currentFacts, baselineFacts, viewer + '/' + member.id + '/' + tab + ': selected member facts');
        if (member.id === 'member:worker-b') assert.match(JSON.stringify(currentFacts), /49%/, 'worker-b keeps its committed context');
      }
      // The page itself became 现在 / 成员 / 记录. The row-level half of the old comparison is kept as: every member the
      // baseline page rendered is still on the page, the page carries exactly the projection's members (no row invented
      // or dropped), and every member name is rendered.
      const ui = createUiStore({ storage: null, tabStorage: null });
      const client = clientFor(viewer);
      for (const module of [baseline, current]) Object.assign(module.TEAM, { client, ui, nav: {}, gateway: null });
      const baselineRows = rowsOf(render(baseline.TeamPage()));
      ui.setPage('members');
      const pageTree = render(current.TeamPage());
      const pageRows = rowsOf(pageTree);
      assert.deepEqual([...baselineRows].filter(id => !pageRows.includes(id)), [], viewer + ': no member the baseline showed is gone');
      assert.deepEqual([...pageRows].sort(), data.members.map(member => member.id).sort(), viewer + ': the page shows the projection rows');
      const texts = textsOf(pageTree).join(' ');
      assert.deepEqual(data.members.map(member => member.name).filter(name => !texts.includes(name)), [], viewer + ': every name renders');
      let groupLabel = null;
      const groupsByMember = new Map();
      for (const node of elementsOf(pageTree)) {
        if (node.props?.['data-group-header']) groupLabel = textsOf(node.children).join('');
        if (node.props?.['data-member']) groupsByMember.set(node.props['data-member'], groupLabel);
      }
      for (const member of data.members) {
        const row = elementsOf(pageTree).find(node => node.props?.['data-member'] === member.id);
        const cells = row.children.filter(node => node.type === 'td');
        const task = data.tasks.find(task => task.id === member.taskId);
        const activity = member.activity;
        const doing = task ? TASK_WORDING[task.id] ?? task.title : activity?.kind === 'maintenance' ? activity.sub ?? '维护中' :
          activity?.tool ? '正在处理任务' : activity?.kind === 'running' ? activity.sub ?? '运行中' :
          member.wait ? '在等 ' + (member.wait.targetLabel ?? '外部输入') : '没有进行中的任务';
        assert.ok(textsOf(cells[1].children).join('').includes(doing), viewer + '/' + member.id + ': doing matches this member');
        const status = member.observed === 'unknown' ? '卡住 · root 在处理' : member.observed === 'retired' ? '已退役' :
          member.desired === 'retired' || member.observed === 'retiring' ? '退役中…' : member.observed === 'frozen' ? '已暂停' :
          member.desired === 'frozen' ? '正在暂停…' : activity?.kind === 'running' ? '正常' : activity?.kind === 'maintenance' ? '维护中' : '空闲';
        assert.equal(textsOf(cells[2].children).join(''), status, viewer + '/' + member.id + ': status');
        assert.equal(row.props['data-group'], member.group ?? '__ungrouped', member.id + ': group id');
        assert.equal(groupsByMember.get(member.id), data.groups.find(g => g.id === member.group)?.label ?? '未分组', member.id + ': group label');
      }
      // Old Situation/NeedsYou/Pipeline facts move to Now; every task/thread/message remains discoverable in Records/L2.
      const panel = withPanelBlocks(data, viewer, NOW), state = { ...client.getSnapshot(), data: panel };
      const replaceClient = patch => { current.TEAM.client = { subscribe: () => () => {}, getSnapshot: () => ({ ...state, ...patch }) }; };
      replaceClient({ lastEventAt: Date.now(), lastActivityAt: Date.now(), streamOpen: true, heartbeat: true });
      ui.setPage('now');
      const nowText = textOf(current.TeamPage());
      assert.ok(textsOf(render(baseline.TeamPage())).join(' ').includes(data.goal.title), 'the old page protected the goal');
      assert.ok(nowText.includes('目标：' + data.goal.title), 'Now still exposes the exact goal');
      assert.ok(nowText.includes(panel.summary.headline.text), 'the published status cannot disappear');
      assert.ok(nowText.includes('已验收 ' + panel.delivery.accepted + '/' + panel.delivery.total), 'progress keeps accepted versus total');
      assert.equal(panel.delivery.accepted, data.tasks.filter(t => t.state === 'accepted').length);
      assert.equal(panel.delivery.total, data.tasks.filter(t => t.state !== 'cancelled').length);
      const pageNodes = nodes(current.TeamPage());
      assert.equal(pageNodes.filter(n => n.props?.['data-v3'] === 'member-summary').length, 1);
      assert.equal(pageNodes.filter(n => n.props?.['data-readonly'] === 'viewer').length, viewer === 'member:nobody' ? 1 : 0);
      assert.equal(pageNodes.filter(n => n.props?.['data-escalation']).length, viewer === 'member:nobody' ? 0 : panel.escalations.length);
      ui.setPage('records');
      const recordsText = textOf(RecordsPage({ data: panel, now: NOW, initialPage: mockActivity(panel, { limit: 500 }, NOW) }));
      assert.deepEqual([...data.tasks.map(t => TASK_WORDING[t.id] ?? t.title), ...data.threads.map(t => t.question),
        ...data.messages.map(m => MESSAGE_WORDING[m.id] ?? m.summary ?? m.expectedOutcome)]
        .filter(Boolean).filter(fact => !recordsText.includes(fact)), [],
      'every task/discussion/message remains discoverable after display-only ID removal');
      assert.doesNotMatch(recordsText, /(?:task|int|msg|thr)[-:]\d+/, 'record prose does not leak fixture IDs');
      for (const page of ['now', 'members', 'records']) {
        ui.setPage(page);
        replaceClient({ status: 'ready', lastEventAt: Date.now(), lastActivityAt: Date.now(), streamOpen: true, heartbeat: true });
        assert.equal(nodes(current.TeamPage()).some(n => n.props?.['data-fresh']), false, page + ' has no false stale warning');
        replaceClient({ status: 'ready', serverStale: true });
        assert.ok(nodes(current.TeamPage()).some(n => n.props?.['data-fresh'] === 'stale'), page + ' keeps stale evidence');
        replaceClient({ status: 'error', error: 'offline', retryAt: NOW + 5000 });
        const broken = current.TeamPage();
        assert.match(textOf(broken), /连不上团队状态/);
        assert.ok(nodes(broken).some(n => n.type === 'button' && textOf(n) === '重试'), page + ' has recovery');
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P5 review: off renders exactly the five legacy tabs; inactive/stale viewers get no resource writes', () => {
  const ui = { detail: { tab: 'thread', id: null } };
  const tabs = data => Detail({ data, now: NOW, ui }).children[0].children[0].map(node => node.children[0]);
  assert.deepEqual(tabs(scenarioDefault(NOW)), ['成员', '任务', '线程', '消息', '上下文']);
  assert.deepEqual(tabs(scenarioBorrow(NOW)), ['成员', '任务', '线程', '资源', '消息', '上下文']);
  const data = scenarioBorrow(NOW), thread = data.resourceThreads[0];
  assert.deepEqual(resourceActions(data, thread, 'operator'), []);
  const inactive = { ...data, members: data.members.map(m => ({ ...m, desired: 'frozen' })) };
  for (const member of inactive.members) assert.deepEqual(resourceActions(inactive, thread, member.id), []);
  const stale = { ...data, members: data.members.map(m => ({ ...m, generation: 999 })) };
  assert(!resourceActions(stale, thread, 'member:sc-1').includes('publishResource'));
});

test('P5 fixture: resourceThreads is separate from decision threads and carries the v1 blocks', () => {
  const data = scenarioBorrow(NOW);
  assert.equal(data.resourceThreads.length, 1);
  assert.equal(data.threads.some(thread => thread.id === data.resourceThreads[0].id), false);
  assert.equal(data.resourceThreads[0].kind, 'resource');
  assert.equal(resourceThreadsOf(data).length, 1);
  assert.equal(resourceThreadsOf(scenarioDefault(NOW)).length, 0, 'an off fixture has no resource collection');
  const capacity = capacityView(data);
  assert.equal(capacity.normal.limit, 8);
  assert.equal(capacity.human.limit, 1);
  assert.equal(capacity.human.unknown, 1);
  assert.equal(capacity.admissionClosed, true);
  assert.equal(capacity.providerCapacity, 'unknown');
  // Gap 3: the client keeps the server classification and never upgrades an unreadable value to 'available'.
  assert.equal(capacity.providerWait, 'none');
  assert.equal(capacity.providerRetryAfterMs, null);
  assert.equal(capacity.providerRecoveryAt, null);
  const throttled = capacityView({ capacity: { ...data.capacity, providerCapacity: 'throttled',
    providerWait: 'provider-throttled', providerRetryAfterMs: 5000, providerRecoveryAt: NOW + 5000 } });
  assert.equal(throttled.providerCapacity, 'throttled');
  assert.equal(throttled.providerWait, 'provider-throttled');
  assert.equal(throttled.providerRecoveryAt, NOW + 5000);
  const garbage = capacityView({ capacity: { ...data.capacity, providerCapacity: 'availableish', providerWait: 'maybe' } });
  assert.equal(garbage.providerCapacity, 'unknown');
  assert.equal(garbage.providerWait, 'none');
  assert.equal(laneText(capacity.normal), '5/8');
  assert.equal(laneText({ current: 3, limit: null }), '3/?', 'an unpublished limit is unknown, never 0');
  const guard = roleGuardView(data);
  assert.equal(guard.coordinatorOnly, true);
  assert.equal(guard.installed, true);
  assert.equal(guard.denials, 3);
  assert.equal(guard.audit.byTool[0].identity, 'bash');
  const inputs = inputsView(data);
  assert.equal(inputs.count, 1);
  assert.equal(inputs.latest.omittedCount, 1);
  assert.equal(inputs.pendingCount, 4);
  assert.equal(capacityView(scenarioDefault(NOW)), null);
  assert.equal(roleGuardView(scenarioDefault(NOW)), null);
  assert.equal(inputsView(scenarioDefault(NOW)), null);
});

test('P5 attention: only states a person must see become a line; a healthy team stays silent', () => {
  const data = scenarioBorrow(NOW);
  const root = borrowAttention(data, MOCK_VIEWER).map(item => item.title).join(' | ');
  assert.match(root, /执行准入已关闭/);
  assert.match(root, /交互名额有 1 个 unknown/);
  assert.match(root, /件人工\/协调请求在等 root/);
  assert.match(root, /未获放行/);
  assert.match(root, /root 已拒绝 3 次/);
  assert.match(root, /未装入/);
  const member = borrowAttention(data, 'member:worker-b').map(item => item.title).join(' | ');
  assert.match(member, /件事在等组长决定/);
  assert.doesNotMatch(member, /root 已拒绝/, 'per-tool denial detail is root\'s');
  const healthy = { ...scenarioDefault(NOW), capacity: { normal: { current: 0, limit: 8, unknown: 0, queued: 0 },
    human: { current: 0, limit: 1, unknown: 0, queued: 0 }, unknown: 0, admissionClosed: false, blocked: [], occupants: [],
    providerCapacity: 'unknown' } };
  assert.deepEqual(borrowAttention(healthy, MOCK_VIEWER), [], 'normal capacity takes no space');
});

test('P5 needsYou: a resource thread is never a response obligation', () => {
  const data = scenarioBorrow(NOW);
  const mixed = { ...data, threads: [...data.threads, { ...data.resourceThreads[0], question: 'resource?', state: 'open',
    owner: MOCK_VIEWER, escalationOwner: MOCK_VIEWER, deadline: NOW - 1 }] };
  assert.equal(needsYou(mixed, NOW, MOCK_VIEWER).some(item => item.id === data.resourceThreads[0].id), false);
});

test('P5 SSE: applyEvent replaces resourceThreads and the whole v1 blocks', () => {
  const base = scenarioDefault(NOW);
  const data = scenarioBorrow(NOW);
  const next = applyEvent(base, { upserts: { resourceThreads: data.resourceThreads },
    capacity: data.capacity, roleGuard: data.roleGuard, inputs: data.inputs });
  assert.equal(next.resourceThreads.length, 1);
  assert.equal(next.capacity.admissionClosed, true);
  assert.equal(next.roleGuard.denials, 3);
  assert.equal(next.inputs.latest.id, 'manifest:borrow-1');
  const removed = applyEvent(next, { removes: { resourceThreads: [data.resourceThreads[0].id] } });
  assert.deepEqual(removed.resourceThreads, []);
  // Absent collections/blocks keep exactly the data they had (no fabricated empty team).
  const untouched = applyEvent(base, { upserts: { members: [] } });
  assert.equal(Object.hasOwn(untouched, 'capacity'), false);
  assert.equal(Object.hasOwn(untouched, 'resourceThreads'), false);
});

test('P5 commands: the UI shows only actions the viewer may take, and the palette is the only entry', () => {
  const data = scenarioBorrow(NOW);
  const thread = data.resourceThreads[0];
  assert.deepEqual(resourceActions(data, thread, 'member:worker-b'), ['subscribeResource']);
  assert.deepEqual(resourceActions(data, thread, 'member:sc-1'), ['publishResource', 'unsubscribeResource']);
  assert.deepEqual(resourceActions(data, thread, 'member:root'), ['subscribeResource', 'closeResource']);
  assert.deepEqual(resourceActions(data, thread, 'member:nobody'), []);
  const publish = commandFor('publishResource', thread, data, 'member:sc-1');
  assert.equal(publish.hardDisabled, false);
  assert.equal(publish.fields.length, 3);
  assert.match(publish.operationId, /^v1:operation:ui-publish-[A-Za-z0-9._-]+$/);
  assert.match(publish.name, /^threads\.publish$/);
  const secondPublish = commandFor('publishResource', thread, data, 'member:sc-1');
  assert.notEqual(publish.operationId, secondPublish.operationId, 'each palette has a collision-resistant operation id');
  assert.equal(commandFor('publishResource', thread, data, 'member:worker-b').hardDisabled, true);
  assert.equal(commandFor('closeResource', thread, data, 'member:root').hardDisabled, false);
  assert.equal(commandFor('closeResource', thread, data, 'member:sc-1').hardDisabled, true);
  assert.equal(commandFor('subscribeResource', thread, data, 'member:worker-b').hardDisabled, false);
});

test('P5 frozen: every resource write is hard-disabled before submission', () => {
  const data = scenarioBorrow(NOW);
  const frozen = { ...data, goal: { ...data.goal, completionToken: 'prepared' } };
  const thread = data.resourceThreads[0];
  for (const [kind, viewer] of [['subscribeResource', 'member:worker-b'], ['publishResource', 'member:sc-1'],
    ['unsubscribeResource', 'member:sc-1'], ['closeResource', 'member:root']]) {
    const command = commandFor(kind, thread, frozen, viewer);
    assert.equal(command.hardDisabled, true, kind);
    assert.match(command.disabledReason, /COMPLETION_FROZEN/, kind + ' explains the freeze');
    assert.deepEqual(command.fields, [], kind + ' shows no form it cannot submit');
    assert.equal(commandFor(kind, thread, data, viewer).hardDisabled, false, kind + ' is usable without the token');
  }
});

test('P5 mock: subscribe and publish are reflected only through later projection events', async () => {
  const mock = createMockSource({ fixture: 'borrow', tickMs: 40 });
  const client = new ProjectionClient(mock.source, { now: () => Date.now() });
  await client.start();
  try {
    const thread = client.getSnapshot().data.resourceThreads[0];
    const receipt = await mock.gateway.submit({ name: 'threads.subscribe', target: thread.id,
      expectedRevision: thread.revision, args: {} });
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    await waitFor(() => client.getSnapshot().data.resourceThreads[0].subscribers.some(sub => sub.memberId === MOCK_VIEWER && sub.state === 'active'),
      'the subscribed event');
    const subscribed = client.getSnapshot().data.resourceThreads[0];
    const publish = await mock.gateway.submit({ name: 'threads.publish', target: subscribed.id,
      expectedRevision: subscribed.revision, args: { eventType: 'change-reported', summary: 'mock publish' } });
    assert.equal(publish.status, 'accepted', JSON.stringify(publish));
    await waitFor(() => client.getSnapshot().data.resourceThreads[0].lastEvent?.summary === 'mock publish', 'the publish event');
    const published = client.getSnapshot().data.resourceThreads[0];
    assert.equal(published.head, 4);
    assert.equal(published.lastEvent.eventType, 'change-reported');
  } finally {
    client.stop();
  }
});
