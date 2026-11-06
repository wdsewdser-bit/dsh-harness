// M6 WP-6 follow-up (15 §9 V-23): --tm-done is the "accepted" colour and nothing else.
// The records timeline used to paint its 交付与验收 category green while the row text still said 已产出 (the dot and the
// text disagreed about what green means). These assertions lock both sides: the category → token mapping in code, and
// the stylesheet rules that paint with the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: Symbol('Fragment'),
  useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {}, useRef: value => ({ current: value }),
  useSyncExternalStore: (_sub, get) => get(), useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };

const { SEV, RecordRow } = await import('../src/ui/records.mjs');
const { scenarioDefault, MOCK_VIEWER, withPanelBlocks } = await import('../src/mock.mjs');
const { CSS } = await import('../src/styles.mjs');

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const DATA = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW);
const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
/** One timeline row per category; the delivery one is a produced task, i.e. not accepted. */
const event = category => ({ id: 'task-10', seq: 7, at: NOW, kind: 'task', category,
  subject: { type: 'task', id: 'task-10', name: 'portals 预取策略' }, text: 'portals 预取策略：已产出', tags: ['交付与验收'] });

test('15 §9 V-23: no record category is painted with the accepted colour', () => {
  const tokens = new Set(['bad', 'warn', 'wait', 'ok', 'idle', 'unknown', 'frozen', 'retired']);
  assert.ok(Object.keys(SEV).length >= 5, 'every timeline category is classified');
  for (const category of Object.keys(SEV)) {
    assert.notEqual(SEV[category], 'done', category + ' 不得使用验收绿');
    assert.ok(tokens.has(SEV[category]), category + ' 用既有状态 token，得到 ' + SEV[category]);
    const row = RecordRow({ event: event(category), onOpen: () => {}, data: DATA });
    assert.ok(row && row.props, category + ' 渲染出一行');
    assert.notEqual(row.props['data-sev'], 'done', category + ' 行不得标记为 done');
  }
  // The row that made this fail: a produced delivery task is not an acceptance, whatever its category is called.
  const produced = RecordRow({ event: event('delivery'), onOpen: () => {}, data: DATA });
  assert.match(produced.props['data-sev'], /^(wait|idle|ok)$/, '交付时间线用中性/进行中 token');
});

const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('15 §9 V-23: the only source mapping that yields done is accepted', () => {
  const hits = [];
  for (const file of walk(SRC).filter(name => name.endsWith('.mjs'))) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*'done'/g)) {
      hits.push({ file: path.relative(SRC, file).replaceAll('\\', '/'), key: match[1].replace(/^['"]|['"]$/g, '') });
    }
  }
  assert.ok(hits.length > 0, 'the scan finds the accepted mapping it guards');
  for (const hit of hits) assert.equal(hit.key, 'accepted', hit.file + ': ' + hit.key + ' 不是验收语义');
});

test('15 §9 V-23: the stylesheet paints --tm-done only for accepted semantics', () => {
  const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const painted = rules.filter(rule => rule.body.includes('var(--tm-done)'));
  assert.ok(painted.length >= 3, '进度条与 accepted 状态仍使用这个 token');
  const allowed = /data-sev=done|data-end=accepted|\.tm-v3-prog i$/;
  for (const rule of painted) assert.match(rule.selector, allowed, rule.selector + ' 不是验收语义');
  assert.equal(painted.some(rule => rule.selector.includes('.tm-dot')), false, '连接健康点不再借用验收绿');
  assert.match(CSS, /\.tm-dot\{[^}]*background:var\(--tm-wait\)/);
});
