// M6 WP-4 acceptance (16 §3, 15 §9 V-05/V-06/V-07): the v3 pages read in plain words, fold technical detail behind the
// '.' switch, clip long text instead of letting it overlap, and read the records timeline the projection publishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiStore } from '../src/store.mjs';
import { scenarioDefault, scenarioBorrow, scenarioLongText, scenarioDeadLetter, MOCK_VIEWER, withPanelBlocks,
  mockActivity } from '../src/mock.mjs';
import { CSS } from '../src/styles.mjs';
import { HUMAN_RE, NOW, installReact, loadUi, wire, nodes, textOf, visibleText, buttons, byProp } from '../test-support/v3-tree.mjs';

installReact();
const { TEAM, TeamPage } = await loadUi();
const { RecordsPage, RECORD_CHIPS } = await import('../src/ui/records.mjs');
const { Inspector } = await import('../src/ui/detail.mjs');

const panel = (fixture, viewer = MOCK_VIEWER) => withPanelBlocks(fixture(NOW), viewer, NOW);
const memoryStore = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null,
  setItem: (key, value) => map.set(key, value) }; };
const renderInspector = (data, viewer, kind, id, extra = {}) => {
  const state = wire(TEAM, data, viewer);
  state.openInspector(kind, id, extra);
  return { state, tree: Inspector({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }) };
};

test('15 §9 V-05: with the technical layer closed every page reads in plain words, for every reader', () => {
  const fixtures = { 'default': scenarioDefault, borrow: scenarioBorrow, 'long-text': scenarioLongText,
    deadletter: scenarioDeadLetter };
  const viewers = [MOCK_VIEWER, 'member:worker-a', 'viewer:readonly'];
  for (const [name, fixture] of Object.entries(fixtures)) for (const viewer of viewers) {
    const data = panel(fixture, viewer);
    const events = mockActivity(data, {}, NOW).events;
    for (const page of ['now', 'members']) {
      wire(TEAM, data, viewer); TEAM.ui.setPage(page);
      const text = visibleText(TeamPage());
      assert.ok(!HUMAN_RE.test(text), name + '/' + page + '/' + viewer + ' shows ' + String(text.match(HUMAN_RE)));
    }
    wire(TEAM, data, viewer);
    const records = visibleText(RecordsPage({ data, now: NOW, initialPage: mockActivity(data, {}, NOW) }));
    assert.ok(!HUMAN_RE.test(records), name + '/records/' + viewer + ' shows ' + String(records.match(HUMAN_RE)));
    const member = renderInspector(data, viewer, 'member', 'member:worker-a');
    assert.ok(!HUMAN_RE.test(visibleText(member.tree)), name + '/inspector member/' + viewer);
    const record = renderInspector(data, viewer, 'record', events[0].id, { event: events[0] });
    assert.ok(!HUMAN_RE.test(visibleText(record.tree)), name + '/inspector record/' + viewer);
  }
});

test('16 §3.4 / V-06: the "." switch and the header button open the technical layer, and the choice survives a reload', () => {
  const data = panel(scenarioBorrow);
  const storage = memoryStore();
  const state = wire(TEAM, data, MOCK_VIEWER, { storage, tabStorage: memoryStore() });
  state.openInspector('member', 'member:worker-a');
  const technical = () => byProp(Inspector({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }), 'data-ins', 'technical')[0];
  assert.equal(technical().props.open, undefined, 'collapsed by default');
  const root = nodes(TeamPage()).find(node => typeof node.props?.onKeyDown === 'function');
  assert.ok(root, 'the page owns the key handler');
  const typing = tagName => ({ key: '.', target: { tagName }, preventDefault() {} });
  root.props.onKeyDown(typing('DIV'));
  assert.equal(state.getSnapshot().details, true, 'the dot key turns the layer on');
  assert.equal(technical().props.open, true, 'and the disclosure re-renders open');
  assert.match(visibleText(technical()), /desired \/ observed/, 'the technical values are what it reveals');
  root.props.onKeyDown(typing('INPUT'));
  assert.equal(state.getSnapshot().details, true, 'a dot typed into a field is not the switch');
  const header = buttons(TeamPage()).find(button => String(button.props?.title ?? '').includes('技术细节'));
  assert.ok(header, 'the title row carries the same switch');
  assert.equal(header.props['aria-pressed'], 'true', 'and reports the state');
  header.props.onClick();
  assert.equal(state.getSnapshot().details, false);
  assert.equal(technical().props.open, undefined, 'closing it folds the layer again');
  state.toggleDetails();
  assert.equal(createUiStore(storage, memoryStore()).getSnapshot().details, true, 'the switch is persisted, not session-local');
});

test('15 §9 V-07: long text is clipped by the layout contract, never by overlapping its neighbour', () => {
  const data = panel(scenarioLongText);
  wire(TEAM, data, MOCK_VIEWER); TEAM.ui.setPage('members');
  const table = nodes(TeamPage()).find(node => node.type === 'table');
  assert.ok(table, 'the members page is a real table');
  assert.match(CSS, /\.tm-v3-table\{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed\}/,
    'fixed layout: a long cell cannot widen its column');
  assert.match(CSS, /\.tm-v3-what\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0\}/,
    'the flexible column shrinks and ellipsises');
  assert.match(CSS, /\.tm-v3-table th,\.tm-v3-table td\{[^}]*min-width:0\}/, 'no cell refuses to shrink');
  assert.match(CSS, /\.tm-v3-name\{min-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/,
    'the name column keeps a readable minimum and truncates rather than breaking each character');
  const rows = nodes(table).filter(node => node.type === 'tr' && node.props?.['data-member']);
  assert.equal(rows.length, data.members.length, 'one row per member: nothing is folded into a neighbour');
  const longName = data.members.find(member => member.id === 'member:worker-a');
  for (const row of rows) {
    const cells = (row.children ?? []).filter(child => child && typeof child === 'object' && child.type === 'td');
    assert.equal(cells.length, 3, row.props['data-member'] + ' keeps the three v3 columns');
    assert.equal(cells[1].props.className.includes('tm-v3-what'), true, 'the flexible cell is the one that clips');
    assert.equal(typeof cells[1].props.title, 'string', 'the clipped text keeps its full value in the title');
    assert.equal(cells[0].props.style, undefined, 'no fixed pixel width on the name cell');
  }
  const nameCell = rows.find(row => row.props['data-member'] === longName.id).children[0];
  assert.equal(nameCell.children[0], longName.name, 'a 32-character name is shown whole, wrapped by the column');
  // The records row keeps the same contract: a fixed time column, a dot column, and one shrinkable text column.
  assert.match(CSS, /\.tm-v3-tl li\{display:grid;grid-template-columns:64px 18px minmax\(0,1fr\)[^}]*min-width:0\}/,
    'the free-text track is minmax(0,1fr): it can shrink to zero instead of overrunning');
  assert.match(CSS, /\.tm-v3-tl li>div\{min-width:0;overflow-wrap:anywhere\}/, 'and its text wraps inside that track');
  wire(TEAM, data, MOCK_VIEWER);
  const records = RecordsPage({ data, now: NOW, initialPage: mockActivity(data, {}, NOW) });
  const title = data.tasks.find(task => task.id === 'task-12').title;
  assert.ok(title.length > 100);
  assert.ok(textOf(records).includes(title), 'a 100+ character task title is rendered, not dropped');
});

test('16 §3.3: the records page is the projection timeline — five chips, day group, filters, paging', () => {
  const data = panel(scenarioDeadLetter);
  const activity = mockActivity(data, {}, NOW);
  const state = wire(TEAM, data, MOCK_VIEWER);
  const tree = RecordsPage({ data, now: NOW, initialPage: activity });
  const chips = nodes(tree).filter(node => node.type === 'button' && node.props?.['data-chip']);
  assert.deepEqual(chips.map(chip => chip.props['data-chip']), RECORD_CHIPS.map(([value]) => value), 'the five v3 chips');
  assert.deepEqual(RECORD_CHIPS.map(([, label]) => label), ['全部', '只看异常', '需要你', 'root 的裁决', '交付与验收']);
  const records = nodes(tree).filter(node => node.type === 'li' && node.props?.['data-record']);
  assert.equal(records.length, activity.events.length, 'every published event is one row');
  assert.equal(new Set(records.map(row => row.props['data-category'])).size > 1, true, 'rows keep their categories');
  assert.ok(activity.events.some(event => event.category === 'anomaly'), 'the dead letter is an anomaly row');
  assert.ok(nodes(tree).some(node => String(node.props?.className ?? '').includes('tm-v3-daylabel')), 'grouped by day');
  chips[1].props.onClick();
  assert.equal(state.getSnapshot().recordFilter, 'anomaly', 'the chip drives the request the page makes');
  const selects = nodes(tree).filter(node => node.type === 'select');
  assert.equal(selects.length, 2, 'member and time-range dropdowns');
  const empty = RecordsPage({ data, now: NOW, initialPage: { ...activity, events: [], hasMore: false } });
  assert.match(textOf(empty), /这个筛选下没有记录/);
  assert.ok(buttons(empty).some(button => textOf(button).includes('清除筛选')), 'and offers to clear the filter');
});

test('16 §3.2: the members page names five states in words and shows what each member is doing', () => {
  const data = panel(scenarioDefault);
  wire(TEAM, data, MOCK_VIEWER); TEAM.ui.setPage('members');
  const statuses = nodes(TeamPage()).filter(node => node.props?.['data-status']);
  assert.equal(statuses.length, data.members.length);
  const words = /^(正常|空闲|卡住 · root 在处理|已暂停|正在暂停…|退役中…|已退役|维护中)$/;
  for (const status of statuses) assert.match(textOf(status), words, status.props['data-status']);
  assert.ok(new Set(statuses.map(status => textOf(status))).size >= 3, 'V-14 needs three distinguishable shapes');
  const doing = nodes(TeamPage()).filter(node => String(node.props?.className ?? '').includes('tm-v3-what'));
  assert.ok(doing.length >= data.members.length, 'every row says what the member is doing');
  assert.ok(doing.every(node => textOf(node).length > 0), 'and never leaves the column blank');
});
