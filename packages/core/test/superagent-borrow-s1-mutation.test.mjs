import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runS1Process } from '../test-support/s1-process-runner.mjs';

const waitFor = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
};

// Run only the S1 suite in an isolated source copy. Never mutate the live tree or weaken its assertions.
test('S1 review mutations are killed by behavioral assertions, not import failures', {timeout:300000}, async () => {
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-s1-mutations-'));
  try {
    fs.cpSync(path.join(repo,'packages'),path.join(dir,'packages'),{recursive:true,
      filter:source=>!['node_modules','.scratch'].includes(path.basename(source))});
    fs.mkdirSync(path.join(dir,'runs'),{recursive:true});
    const env={...process.env,FORCE_COLOR:'0'};
    delete env.NODE_TEST_CONTEXT; // A nested runner must not inherit the parent's internal serialization mode.
    // Progress and a separate hard cap, both explicit: a slow run that keeps producing TAP output is never mistaken for
    // a hung tree, and a tree that never stops producing output is still bounded (3x the old 30s spawnSync budget).
    const run=()=>{
      const tempRoot=fs.mkdtempSync(path.join(dir,'run-tmp-'));
      return runS1Process({file:'packages/core/test/superagent-borrow-s1.test.mjs',
        args:['--test','--test-reporter=tap'],
        scriptArgs:['packages/core/test/superagent-borrow-s1-decisions.test.mjs',
          'packages/core/test/superagent-borrow-s1-review.test.mjs'],cwd:dir,
        env:{...env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot},
        idleTimeoutMs:120000,timeoutMs:180000});
    };
    const manifestOf=root=>{const out=new Map();const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,
      entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())out.set(path.relative(root,full).split(path.sep).join('/'),createHash(
      'sha256').update(fs.readFileSync(full)).digest('hex'));}};walk(root);return out;};
    const drift=(before,after)=>[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).sort();
    const baselineFiles=manifestOf(path.join(dir,'packages'));
    const baseline=await run();
    assert.equal(baseline.stalled??false,false,'run made no progress for 120s: '+baseline.stopReason+'\n'+baseline.stdout+baseline.stderr);
    assert.equal(baseline.timedOut??false,false,'run hit its 180s hard cap: '+baseline.stopReason+'\n'+baseline.stdout+baseline.stderr);
    assert.equal(baseline.terminated,true,'the controlled tree was not confirmed gone');
    assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
    assert.match(baseline.stdout,/# tests (?:[1-9]\d*)/);
    assert.match(baseline.stdout,/# fail 0/);
    const mutants=[
      {file:'thread-events.mjs',old:'generationOf(member) !== sub.generation',replacement:'false',killedBy:'T03: subscribe/publish/unsubscribe'},
      {file:'commands/intents.mjs',old:'  if (!block) return;',replacement:'  if (true) return;',killedBy:'T05: produce, verify'},
      {file:'thread-events.mjs',old:"if (resolved !== root && !resolved.startsWith(root + '/'))",replacement:'if (false)',killedBy:
        'review: file-area aliases and junction escapes'},
      {file:'commands/messages.mjs',old:'...p.evidenceRefs.map(ref =>',replacement:'...p.evidenceRefs.slice(0, 4).map(ref =>',killedBy:
        'review: retention bounds and all decision evidence'},
    ];
    for(const mutant of mutants) {
      const file=path.join(dir,'packages/core',mutant.file),original=fs.readFileSync(file,'utf8');
      assert.equal(original.split(mutant.old).length-1,1,'unique mutation site: '+mutant.file);
      try {
        fs.writeFileSync(file,original.replace(mutant.old,mutant.replacement));
        const result=await run(),output=result.stdout+result.stderr;
        assert.equal(result.stalled??false,false,'run made no progress for 120s: '+result.stopReason+'\n'+output);
        assert.equal(result.timedOut??false,false,'run hit its 180s hard cap: '+result.stopReason+'\n'+output);
        assert.equal(result.terminated,true,'the controlled tree was not confirmed gone');
        assert.notEqual(result.status,0,'surviving mutant: '+mutant.file);
        assert.match(output,/AssertionError/,'a parser/import failure does not kill a behavioral mutant');
        assert(output.split('\n').some(line=>line.trimStart().startsWith('not ok ') && line.includes(mutant.killedBy)),
          'the intended regression must FAIL: '+mutant.killedBy);
      } finally { fs.writeFileSync(file,original); }
    }
    const changed=drift(baselineFiles,manifestOf(path.join(dir,'packages')));
    assert.deepEqual(changed,[],'the restored source differs from the baseline bytes: '+changed.slice(0,5).join(', '));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

/** A fake spawn child: enough of ChildProcess for the runner, with no real process behind it. */
const fakeChild = () => { const child = new EventEmitter(); child.pid = undefined; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  return child; };

test('S1 runner: error(EBUSY) then close settles once and the retried outcome is returned', async () => {
  const children = [];
  const pending = runS1Process({ file: 'ignored.test.mjs', args: ['--test'], idleTimeoutMs: 5000, timeoutMs: 30000,
    confirmTimeoutMs: 500, spawnChild: () => { const child = fakeChild(); children.push(child); return child; } });
  assert.equal(children.length, 1);
  children[0].emit('error', Object.assign(Error('spawn EBUSY'), { code: 'EBUSY' }));
  // The failed child's close arrives after its error. It must not resolve the first promise a second time and must not
  // stop the retry from starting.
  children[0].emit('close', 1, null);
  await waitFor(() => children.length === 2);
  assert.equal(children.length, 2, 'an EBUSY spawn is retried');
  children[1].emit('exit', 0, null);
  children[1].emit('close', 0, null);
  const result = await pending;
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.error, null);
  assert.equal(result.terminated, true);
  assert.equal(result.stalled, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.stopReason, 'close');
  assert.equal(children.length, 2, 'exactly one retry');
});

test('S1 runner: a failed retry propagates its own error instead of the EBUSY one', async () => {
  const children = [];
  const pending = runS1Process({ file: 'ignored.test.mjs', args: ['--test'], idleTimeoutMs: 5000, timeoutMs: 30000,
    confirmTimeoutMs: 500, spawnChild: () => { const child = fakeChild(); children.push(child); return child; } });
  children[0].emit('error', Object.assign(Error('spawn EBUSY'), { code: 'EBUSY' }));
  children[0].emit('close', 1, null);
  await waitFor(() => children.length === 2);
  children[1].emit('error', Object.assign(Error('spawn EACCES'), { code: 'EACCES' }));
  children[1].emit('close', 1, null);
  const result = await pending;
  assert.equal(children.length, 2, 'a non-EBUSY failure is not retried');
  assert.equal(result.error?.code, 'EACCES', JSON.stringify(result.error));
  assert.equal(result.status, null);
  assert.equal(result.terminated, true, 'no process existed, so nothing was left alive');
});
