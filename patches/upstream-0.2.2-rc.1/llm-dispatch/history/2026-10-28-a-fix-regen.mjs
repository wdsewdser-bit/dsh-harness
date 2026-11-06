import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * Regenerate the llm-dispatch candidate after the send-started scope fix (A pack, review item 5).
 * plan.json is the single source of the literal edits; this script re-derives anchors.json, candidate.patch and
 * patch-stats.json from the pristine originals. It never writes a build: apply.mjs is what writes a copy.
 */
const DIR = 'patches/upstream-0.2.2-rc.1/llm-dispatch';
const FILES = ['dsh-llm/lib/index.js', 'dsh-llm-deepseek/lib/index.js'];
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const fail = message => { throw new Error(message); };

const planPath = path.join(DIR, 'plan.json');
const anchorsPath = path.join(DIR, 'anchors.json');
const anchorsMeta = JSON.parse(read(anchorsPath));
const originals = new Map(FILES.map(file => [file, read(path.join(DIR, 'original', file))]));

const seen = new Set();
const plan = JSON.parse(read(planPath)).filter(item => {
  if (seen.has(item.name)) return false;
  seen.add(item.name);
  return true;
});
const entry = name => {
  const found = plan.find(item => item.name === name);
  if (!found) fail('no plan entry named ' + name);
  return found;
};

const HELPER = [
  '/**',
  '* Whether an adapter has joined the send-started contract.',
  '*',
  '* An adapter that never reports send-started can still have sent the request and thrown: its counter is zero either',
  '* way, so a zero counter alone proves nothing. Only an adapter that declares the contract may be reported as',
  '* failed(notSent); for every other adapter the attempt stays unconfirmed, which is the truth the host can act on.',
  '*/',
  'function declaresDispatchPhase(adapter) {',
  '\tif (adapter === null || typeof adapter !== "object") return false;',
  '\treturn adapter.dispatchContract === DISPATCH_CONTRACT;',
  '}',
].join('\n');

const registry = entry('llm.dispatch-registry');
if (!registry.to.includes('function dispatchAttemptOf(options)')) fail('the registry edit changed shape');

if (!registry.to.includes('function mintDispatchAttempt(service, request, finalOptions, adapter)')) {
  const plain = 'function mintDispatchAttempt(service, request, finalOptions) {';
  if (registry.to.split(plain).length - 1 !== 1) fail('the mint signature changed shape');
  registry.to = registry.to.replace(plain, 'function mintDispatchAttempt(service, request, finalOptions, adapter) {');
}
if (!registry.to.includes('declaresPhases')) {
  const marker = '\t\tsendStartedCount: 0,';
  if (registry.to.split(marker).length - 1 !== 1) fail('the attempt literal changed shape');
  registry.to = registry.to.replace(marker, marker + '\n\t\tdeclaresPhases: declaresDispatchPhase(adapter),');
}
{
  const RUNTIME = 'let LlmRuntime = (() => {';
  const at = registry.to.lastIndexOf(RUNTIME);
  if (at < 0) fail('the runtime marker is missing from the registry edit');
  const head = registry.to.slice(0, at).split(HELPER).join('').trimEnd();
  registry.to = HELPER + '\n' + head + '\n' + RUNTIME;
}

for (const name of ['llm.adapterStream-catch', 'llm.iteration-catch']) {
  const item = entry(name);
  const condition = 'if (attempt !== void 0 && attempt.sendStartedCount === 0) attempt.phase("failed", {';
  const guarded = 'if (attempt !== void 0 && attempt.sendStartedCount === 0 && attempt.declaresPhases) attempt.phase("failed", {';
  if (!item.to.includes('declaresPhases')) {
    const count = item.to.split(condition).length - 1;
    if (count !== 1) fail(name + ': expected the failure condition once, found ' + count);
    item.to = item.to.replace(condition, guarded);
  }
  item.to = item.to.split('&& declaresDispatchPhase(adapter))').join('&& attempt.declaresPhases)');
}

const exportsEdit = entry('llm.exports');
if (!exportsEdit.to.includes('dispatchAttemptOf,')) fail('the export edit changed shape');
if (!exportsEdit.to.includes('DISPATCH_CONTRACT')) exportsEdit.to = exportsEdit.to.replace('APP_IDENTITY, dispatchAttemptOf,', 'APP_IDENTITY, DISPATCH_CONTRACT, dispatchAttemptOf,');

const dispatchCall = entry('llm.dispatch-call');
if (!dispatchCall.to.includes('mintDispatchAttempt(this, options, finalOptions, adapter)')) {
  const plain = 'mintDispatchAttempt(this, options, finalOptions)';
  if (dispatchCall.to.split(plain).length - 1 !== 1) fail('the dispatch-call edit changed shape');
  dispatchCall.to = dispatchCall.to.replace(plain, 'mintDispatchAttempt(this, options, finalOptions, adapter)');
}

const deepseekImport = entry('deepseek.import-llm');
if (!deepseekImport.to.includes('dispatchAttemptOf')) fail('the deepseek import edit changed shape');
if (!deepseekImport.to.includes('DISPATCH_CONTRACT')) deepseekImport.to = deepseekImport.to.replace('dispatchAttemptOf,', 'DISPATCH_CONTRACT, dispatchAttemptOf,');
for (const [name, file, anchor, to] of [
  ['llm.adapter-declaration', 'dsh-llm/lib/index.js', 'var LlmAdapter = class {',
    'var LlmAdapter = class {\n\t/** The dispatch-phase contract this adapter implements; null until the adapter joins it. */\n\tdispatchContract = null;'],
  ['deepseek.adapter-declaration', 'dsh-llm-deepseek/lib/index.js', 'var DeepSeekAdapter = class extends LlmAdapter {',
    'var DeepSeekAdapter = class extends LlmAdapter {\n\tdispatchContract = DISPATCH_CONTRACT;'],
]) {
  if (!plan.some(item => item.name === name)) plan.push({ file, name, from: anchor, to });
}

const patched = new Map(FILES.map(file => [file, originals.get(file)]));
for (const item of plan) {
  if (!patched.has(item.file)) fail('plan entry for an unknown file: ' + item.file);
  const text = patched.get(item.file);
  const count = text.split(item.from).length - 1;
  if (count !== 1) fail(item.name + ' matched ' + count + ' times (expected 1)');
  patched.set(item.file, text.split(item.from).join(item.to));
}

const anchors = plan.map(item => {
  const original = originals.get(item.file);
  const at = original.indexOf(item.from);
  if (at < 0) fail('the anchor is not in the original: ' + item.name);
  if (original.split(item.from).length - 1 !== 1) fail('the anchor is not unique in the original: ' + item.name);
  return { file: item.file, name: item.name, count: 1, text: item.from, postText: item.to, line: original.slice(0, at).split('\n').length };
});
anchorsMeta.files = {};
for (const file of FILES) anchorsMeta.files[file] = { preimage: sha(originals.get(file)), postimage: sha(patched.get(file)) };
anchorsMeta.anchors = anchors;
fs.writeFileSync(anchorsPath, JSON.stringify(anchorsMeta, null, 2) + '\n');
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');

const work = 'runs/m1b-A-fix/patchgen';
fs.rmSync(work, { recursive: true, force: true });
for (const file of FILES) {
  for (const [dir, text] of [['old', originals.get(file)], ['new', patched.get(file)]]) {
    const target = path.join(work, dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}
let patch = '';
for (const file of FILES) {
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--src-prefix=', '--dst-prefix=', path.join('old', file), path.join('new', file)], {
    cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 1) fail('git diff failed for ' + file + ': ' + result.stderr);
  const kept = result.stdout.split('\n').filter(line => !line.startsWith('diff --git') && !line.startsWith('index '));
  patch += kept.map(line => {
    if (line.startsWith('--- ')) return '--- a/' + file;
    if (line.startsWith('+++ ')) return '+++ b/' + file;
    return line;
  }).join('\n');
}
fs.writeFileSync(path.join(DIR, 'candidate.patch'), patch);
const lines = patch.split('\n');
const hunks = lines.filter(line => line.startsWith('@@')).length;
const added = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
const removed = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
fs.writeFileSync(path.join(DIR, 'patch-stats.json'), JSON.stringify({ hunks, added, removed }, null, 2) + '\n');

const patchedLlm = patched.get('dsh-llm/lib/index.js');
const helperAt = patchedLlm.indexOf('function declaresDispatchPhase');
const runtimeAt = patchedLlm.indexOf('let LlmRuntime = (() => {');
if (!(helperAt > 0 && helperAt < runtimeAt)) fail('the declaration helper is not at module scope');
console.log(JSON.stringify({ files: anchorsMeta.files, hunks, added, removed, anchors: anchors.length, plan: plan.length, helperAt, runtimeAt }, null, 2));
