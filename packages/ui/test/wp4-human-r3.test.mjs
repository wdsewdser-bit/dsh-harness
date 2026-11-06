import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPresentation } from '../src/activity.mjs';
import { installReact } from '../test-support/v3-tree.mjs';
installReact();
const { memberDoing } = await import('../src/ui/lanes.mjs');

const preserved = [
  ['实现 task-based scheduling', '实现 task-based scheduling'],
  ['修改 audit-log.md 并验证 task-runner.mjs', '修改 audit-log.md 并验证 task-runner.mjs'],
  ['保留 delivery-ready 分支', '保留 delivery-ready 分支'],
  ['查看 https://example.com/task-runner/docs', '查看 https://example.com/task-runner/docs'],
  ['查看 https://example.com/task-8?q=int-41#task-8', '查看 https://example.com/task-8?q=int-41#task-8'],
  ['查看 ftp://example.com/task-8?q=int-41', '查看 ftp://example.com/task-8?q=int-41'],
  ['查看 file:///C:/docs/task-8?q=int-41', '查看 file:///C:/docs/task-8?q=int-41'],
  ['修改 task-8.mjs 和 audit-log.md', '修改 task-8.mjs 和 audit-log.md'],
  ['保留 release/task-8 与 task-8-ready 分支', '保留 release/task-8 与 task-8-ready 分支'],
  ['查看 task:alpha-copy 和 task:unconfirmed', '查看 task:alpha-copy 和 task:unconfirmed'],
  ['task-based task-runner audit-log delivery-ready', 'task-based task-runner audit-log delivery-ready'],
];

for (const [input, expected] of preserved) test('production memberDoing/recordPresentation preserve: ' + input, () => {
  const member = { id: 'member:author', taskId: 'task:work', activity: { kind: 'running' } };
  const data = { members: [member], tasks: [{ id: 'task:work', title: input }, { id: 'task:alpha', title: '已确认任务' }],
    auditTrail: [{ id: 'audit:log' }] };
  assert.equal(memberDoing(member, data), expected);
  const event = { id: 'task:work', kind: 'task', subject: { id: 'task:work', name: input }, text: input + '：保留 delivery-ready 分支' };
  assert.deepEqual(recordPresentation(data, event), { title: expected, text: '保留 delivery-ready 分支' });
  event.text = input;
  assert.deepEqual(recordPresentation(data, event), { title: expected, text: expected });
  assert.equal(data.tasks[0].title, input, 'the raw projection remains unchanged');
});

test('only complete confirmed tokens and explicit numeric aliases are stripped through both production paths', () => {
  const member = { id: 'member:author', taskId: 'task:alpha' };
  const data = { members: [member], tasks: [{ id: 'task:alpha', title: '协调 task:alpha 后处理 task-8 与 int-41' }] };
  assert.equal(memberDoing(member, data), '协调 后处理 与');
  assert.deepEqual(recordPresentation(data, { id: 'decision:closed', kind: 'decision',
    subject: { id: 'decision:closed', name: '裁决 decision:closed' }, text: '检查 decision:closed，再处理 task:alpha' }),
  { title: '裁决', text: '检查 ，再处理' });
  data.tasks[0].title = 'task:alpha-copy task:alpha.mjs /task:alpha task:unknown';
  assert.equal(memberDoing(member, data), 'task:alpha-copy task:alpha.mjs /task:alpha task:unknown');
  data.tasks[0].title = '验收 task-8 帧图依赖排序';
  assert.equal(memberDoing(member, data), '验收 帧图依赖排序');
  data.tasks[0].title = '最终验收：集成分支 int-41';
  assert.equal(memberDoing(member, data), '最终验收：集成分支');
});
