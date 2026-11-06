import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioDefault, withPanelBlocks, mockActivity, MOCK_VIEWER } from '../src/mock.mjs';
import { installReact, wire, nodes, visibleText, NOW } from '../test-support/v3-tree.mjs';
import { humanText } from '../src/human-text.mjs';
installReact();
const { TEAM, TeamPage } = await import('../src/ui.mjs');
const { RecordRow, RecordsPage } = await import('../src/ui/records.mjs');
const { Inspector } = await import('../src/ui/detail.mjs');
const { handleDetailsKey } = await import('../src/ui/page.mjs');
const IDS = /\b(?:member|task|thread|message|attempt|delivery|intent|int|thr|msg|decision|audit|effect|apr)[-:][A-Za-z0-9._:/-]+/;

test('embedded fixture IDs are absent from all collapsed records and every member doing/inspector, not just exact-ID titles', () => {
  const data = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW), before = structuredClone(data);
  const ui = wire(TEAM, data, MOCK_VIEWER); ui.setPage('members');
  assert.doesNotMatch(visibleText(TeamPage()), IDS);
  for (const member of data.members) {
    ui.openInspector('member', member.id);
    assert.doesNotMatch(visibleText(Inspector({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} })), IDS, member.id);
  }
  const page = mockActivity(data, { limit: 500 }, NOW);
  assert.ok(page.events.some(event => /task-8|int-41/.test(event.text)), 'the fixture really contains embedded IDs');
  assert.doesNotMatch(visibleText(RecordsPage({ data, now: NOW, initialPage: page })), IDS);
  for (const event of page.events) {
    assert.doesNotMatch(visibleText(RecordRow({ event, data, onOpen() {} })), IDS);
    ui.openInspector('record', event.id, { event });
    assert.doesNotMatch(visibleText(Inspector({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} })), IDS);
  }
  for (const id of ['member:verifier-e', 'member:verifier-final']) {
    ui.openInspector('member', id); ui.set({ details: false });
    const closed = () => Inspector({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} });
    assert.doesNotMatch(visibleText(closed()), /task-8|int-41/);
    ui.toggleDetails(); assert.match(visibleText(closed()), /task-8|int-41/);
  }
  assert.deepEqual(data, before, 'normalization never rewrites the projection or fixture');
  assert.equal(humanText('验收 task-8 帧图依赖排序'), '验收 帧图依赖排序');
  assert.equal(humanText('集成分支 int-41'), '集成分支');
});

test('record click retains keyboard focus and the first dot toggles exactly once, including body focus', () => {
  const ui = wire(TEAM, withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW), MOCK_VIEWER);
  let focused = 0, opened = 0;
  const row = RecordRow({ event: { id: 'task-8', text: '验收 task-8', subject: { id: 'task-8' } }, data: {}, onOpen() { opened++; } });
  assert.equal(row.props.tabIndex, 0);
  row.props.onClick({ currentTarget: { focus() { focused++; } } });
  assert.equal(focused, 1); assert.equal(opened, 1);
  const event = { key: '.', target: { tagName: 'BODY' }, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; } };
  assert.equal(handleDetailsKey(event), true); assert.equal(ui.getSnapshot().details, true);
  assert.equal(handleDetailsKey(event), false, 'capture plus bubbling must not toggle twice');
  assert.equal(ui.getSnapshot().details, true);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(handleDetailsKey({ key: '.', target: { tagName }, preventDefault() { throw Error('typed dot was intercepted'); } }), false);
  }
});
