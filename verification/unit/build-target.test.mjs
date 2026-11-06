import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { buildTarget, selectedBuild } from '../../packages/adapter-dsh/build-target.mjs';

const repoPackages = fileURLToPath(new URL('../../packages', import.meta.url));
import { generate } from '../../packages/profiles/index.mjs';

// The two roots choose exactly one executor; the default is deliberately native and cannot enable the latch.
test('selected patched build chooses exactly one executor in each profile', () => {
  const target=buildTarget(), root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-build-profile-'));
  try {
    assert.equal(target.preemptExecutor,'dsh-tool-executor-preempt');
    for (const team of [false,true]) {
      const profile=generate(path.join(root,String(team)),{team,guard:team,goalCheck:team});
      const entries=profile.entries.filter(e=>/dsh-tool-executor-(native|preempt)$/.test(e.name));
      assert.equal(entries.length,1,'setExecutor accepts one plugin, never two');
      assert.equal(entries[0].name,'@deepseek-ai/dsh-tool-executor-'+(team?'preempt':'native'));
      assert.equal(profile.entries.find(e=>e.name==='@deepseek-ai/dsh-agent-loop').config.instantInterrupt,team?true:undefined);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('missing agent-loop patch, executor manifest or executor implementation fails closed', () => {
  const selected=selectedBuild(), root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-build-missing-'));
  const rels=['dsh/package.json','dsh-llm/lib/index.js','dsh-agent-loop/lib/index.js',
    'dsh-tool-executor-native/package.json','dsh-tool-executor-native/lib/index.js',
    'dsh-tool-executor-preempt/package.json','dsh-tool-executor-preempt/lib/index.js'];
  const base='node_modules/@deepseek-ai/';
  try {
    for (const rel of rels) { const dest=path.join(root,base,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(selected,base,
      rel),
        dest); }
    assert.equal(buildTarget(root).preemptExecutor,'dsh-tool-executor-preempt');
    const missing=()=>assert.throws(()=>buildTarget(root),e=>e.code==='PATCH_MISSING');
    for (const rel of ['dsh-agent-loop/lib/index.js','dsh-tool-executor-preempt/package.json','dsh-tool-executor-preempt/lib/index.js']) {
      const file=path.join(root,base,rel), saved=fs.readFileSync(file);fs.rmSync(file);missing();fs.writeFileSync(file,saved);
    }
    const loop=path.join(root,base,'dsh-agent-loop/lib/index.js'),original=fs.readFileSync(loop,'utf8');
    fs.writeFileSync(loop,original.replace('preemptStep(reason = "preempted")','noPreemptStep(reason = "preempted")')
      .replace('noPreemptStep(reason = "preempted")','preemptionDisabled(reason = "preempted")'));
    missing();
    const prior=process.env.DSH_UPSTREAM_BUILD;process.env.DSH_UPSTREAM_BUILD=root;
    try { assert.throws(()=>generate(path.join(root,'team'),{team:true,guard:true,goalCheck:true}),e=>e.code==='PATCH_MISSING'); }
    finally { if(prior===undefined)delete process.env.DSH_UPSTREAM_BUILD;else process.env.DSH_UPSTREAM_BUILD=prior; }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
/**
 * A source copy that names its build but carries no build/builds.json must fail at the entry that needs the pristine
 * install, with PATCH_MISSING — never by concatenating 'null' into a module URL and reporting "module not found".
 */
test('composing the pristine upstream without build/builds.json fails as PATCH_MISSING', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-build-no-config-'));
  const build = selectedBuild(), prior = process.env.DSH_UPSTREAM_BUILD;
  try {
    for (const dir of ['adapter-dsh', 'contracts']) {
      fs.cpSync(path.join(repoPackages, dir), path.join(root, 'packages', dir), { recursive: true });
    }
    assert.equal(fs.existsSync(path.join(root, 'build', 'builds.json')), false, 'the copy must not carry the configuration');
    process.env.DSH_UPSTREAM_BUILD = build;
    const adapter = await import(pathToFileURL(path.join(root, 'packages', 'adapter-dsh', 'index.mjs')).href);
    assert.equal(adapter.buildTarget().pristine, null, 'the lookup itself stays optional');
    assert.throws(() => adapter.load('dsh-llm'), error => error.code === 'PATCH_MISSING', 'load() refuses to build a URL out of null');
    assert.throws(() => adapter.upstream.root, error => error.code === 'PATCH_MISSING');
  } finally {
    if (prior === undefined) delete process.env.DSH_UPSTREAM_BUILD; else process.env.DSH_UPSTREAM_BUILD = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
