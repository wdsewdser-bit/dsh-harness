import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { installReact, nodes, textOf } from '../test-support/v3-tree.mjs';
installReact();

test('actual generated lib/client.js parses, loads its factory, boots the page and expands the member inspector', async () => {
  const build = spawnSync(process.execPath, [new URL('../build.mjs', import.meta.url).pathname.replace(/^[/]([A-Z]:)/, '$1')],
    { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source));
  let plugin; const slots = new Map(), dispose = [], errors = [];
  const document = { head: { appendChild() {} }, createElement: () => ({ remove() {} }), addEventListener() {}, removeEventListener() {} };
  const context = { console: { ...console, error: (...args) => errors.push(args) }, document, React,
    location: { search: '?teamFixture=long-text' }, localStorage: null, sessionStorage: null,
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, structuredClone, crypto: globalThis.crypto };
  context.window = context;
  context.__ModuleLoader__ = { load: definition => { plugin = definition.factory(name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: () => null };
    throw Error('unexpected dependency: ' + name);
  }); } };
  new vm.Script(source).runInNewContext(context);
  assert.equal(typeof plugin.apply, 'function');
  const ctx = { slots: { inject: (_name, fn) => fn(), register: (seat, component) => slots.set(seat.name, component) },
    layout: { selectPanel() {} }, uiWorkspace: { openSession() {} }, sessions: { list: { getSnapshot: () => ({ ids: [] }) } },
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') dispose.push(cleanup); }, inject() {} };
  plugin.apply(ctx);
  try {
    const runtime = context.__dshTeam;
    await runtime.client.pending;
    assert.equal(runtime.client.getSnapshot().status, 'ready');
    const TeamPage = slots.get('main');
    assert.equal(typeof TeamPage, 'function');
    assert.doesNotThrow(() => nodes(React.createElement(TeamPage)));
    nodes(TeamPage()).find(n => n.props?.['data-tab'] === 'members').props.onClick();
    const rows = nodes(TeamPage()).filter(n => n.props?.['data-member']);
    assert.equal(rows.length, runtime.client.getSnapshot().data.members.length);
    assert.match(textOf(TeamPage()), /跨组适配方案/);
    rows.find(n => n.props['data-member'] === 'member:worker-a').props.onClick();
    const technical = () => nodes(TeamPage()).find(n => n.props?.['data-ins'] === 'technical');
    assert.equal(technical().props.open, undefined);
    nodes(TeamPage()).find(n => n.props?.title === '技术细节开关（.）').props.onClick();
    assert.equal(technical().props.open, true, 'a real React boolean, never the false-like empty string');
    assert.doesNotThrow(() => nodes(TeamPage()), 'labels and real inspector bindings exist inside the factory');
    assert.deepEqual(errors, []);
  } finally { for (const cleanup of dispose.reverse()) cleanup(); }
});
