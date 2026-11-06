import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runControlled } from '../test-support/controlled-run.mjs';
import { runMutant, firstRunTail } from '../test-support/mutant-policy.mjs';
import { buildTarget } from '../../adapter-dsh/index.mjs';

// Run only the S2 suite in an isolated source copy. Never mutate the live tree or weaken its assertions.
test('S2 review mutations are killed by behavioral assertions, not import failures', {timeout:180000}, async () => {
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-s2-mutations-'));
  try {
    fs.cpSync(path.join(repo,'packages'),path.join(dir,'packages'),{recursive:true,
      filter:source=>!['node_modules','.scratch'].includes(path.basename(source))});
    fs.mkdirSync(path.join(dir,'runs'),{recursive:true});
    // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot name
  // the pristine install the adapter composes.
    fs.mkdirSync(path.join(dir,'build'),{recursive:true});fs.copyFileSync(path.join(repo,'build','builds.json'),path.join(dir,'build','builds.json'));
    const env={...process.env,FORCE_COLOR:'0',DSH_UPSTREAM_BUILD:buildTarget().build};
    delete env.NODE_TEST_CONTEXT; // A nested runner must not inherit the parent's internal serialization mode.
    // Progress, not wall clock: a loaded machine that keeps emitting TAP is slower, not hung.
    const run=async()=>{const tempRoot=fs.mkdtempSync(path.join(dir,'run-tmp-'));
      return runControlled({tempRoot,file:'packages/profiles/test/superagent-borrow-s2.test.mjs',args:['--test','--test-reporter=tap',
        'packages/profiles/test/superagent-borrow-s2-review.test.mjs'],
        cwd:dir,env:{...env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot},idleTimeoutMs:120000,timeoutMs:180000});};
    const manifestOf=root=>{const out=new Map();const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,
      entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())out.set(path.relative(root,full).split(path.sep).join('/'),createHash(
      'sha256').update(fs.readFileSync(full)).digest('hex'));}};walk(root);return out;};
    const drift=(before,after)=>[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).sort();
    const baselineFiles=manifestOf(path.join(dir,'packages'));
    const baseline=await run();
    assert.equal(baseline.stalled??false,false,'run made no progress for 120s: '+baseline.stopReason+'\n'+baseline.stdout+baseline.stderr);
    // stalled and timedOut are separate verdicts: silence is not the same as a tree that outran its hard cap.
    assert.equal(baseline.timedOut??false,false,'run hit its 180s hard cap: '+baseline.stopReason+'\n'+baseline.stdout+baseline.stderr);
    assert.equal(baseline.terminated,true,'the controlled tree was not confirmed gone');
    assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
    assert.match(baseline.stdout,/# tests (?:[1-9]\d*)/);
    assert.match(baseline.stdout,/# fail 0/);
    const mutants=[
      // No boundary installation: the owner listener alone cannot protect early listeners or registered bodies.
      {file:'profiles/runtime.mjs',old:'boundary.install(assertCall, () => ctx.agents.currentInitiator?.());',
        replacement:'/* mutant: no final boundary */',killedBy:'R01'},
      {file:'host/src/guard/index.mjs',old:
        "    if (!entry) return Object.freeze({ decision: 'deny', reason: 'UNDECLARED_TOOL', identity, operation, capabilities: null });",
        replacement:"    if (!entry) return Object.freeze({ decision: 'allow', reason: null, identity, operation, capabilities: [] });",killedBy:'R01'},
      {file:'host/src/guard/index.mjs',old:'return entry.implementation === implementation ? entry : null;',
        replacement:'return entry;',killedBy:'R03'},
      {file:'host/src/guard/index.mjs',old:
        "if (decision.applies !== false && (this.#state.revoked || (!this.#state.installed && decision.decision === 'allow'))) {",
        replacement:'if (false) {',killedBy:'R04'},
      {file:'host/src/guard/index.mjs',old:
        "        return Object.freeze({ decision: 'deny', reason: 'UNKNOWN_OPERATION', identity, operation, capabilities: null });",
        replacement:"        return Object.freeze({ decision: 'allow', reason: null, identity, operation, capabilities: [] });",killedBy:'R02'},
      {file:'core/index.mjs',old:
        "if (command.superagentBorrow === 'v1' && (task?.owner === 'member:root' || member?.role === 'root')) fail('ROOT_WORK_ATTEMPT_DENIED');",
        replacement:'/* mutant: root may acquire work */',killedBy:'R02 admission'},
      {file:'profiles/llm-execution.mjs',old:'    agent.model.select(selection);\n    const actual = agent.model.current();',replacement:
        '    const actual = selection; // mutant: report configured as effective',killedBy:'R05'},
      {file:'profiles/runtime.mjs',old:'if (authority.has(guard) && authority.get(guard) !== state.generation) {',
        replacement:'if (false) {',killedBy:'R06'},
      {file:'adapter-dsh/role-tool-boundary.mjs',old:'return run(execution, definition, () => Reflect.apply(body, this, [args, exec]));',
        replacement:'return Reflect.apply(body, this, [args, exec]);',killedBy:'R04'},
    ];
    for(const mutant of mutants) {
      const file=path.join(dir,'packages',mutant.file),original=fs.readFileSync(file,'utf8');
      assert.equal(original.split(mutant.old).length-1,1,'unique mutation site: '+mutant.file);
      let attempt;
      try {
        fs.writeFileSync(file,original.replace(mutant.old,mutant.replacement));
        // Retry only an identified infrastructure failure; a first run that exits 0 is a survivor, immediately.
        attempt=await runMutant(()=>run(),{maxAttempts:2});
      } finally { fs.writeFileSync(file,original); }
      const {result}=attempt,output=result.stdout+result.stderr,evidence=' ('+attempt.evidence+')';
      assert.equal(result.stalled??false,false,'run made no progress for 120s'+evidence+': '+result.stopReason+'\n'+output);
      assert.equal(result.timedOut??false,false,'run hit its 180s hard cap'+evidence+': '+result.stopReason+'\n'+output);
      assert.equal(result.terminated,true,'the controlled tree was not confirmed gone'+evidence);
      assert.equal(result.error??null,null,String(result.error));
      assert.equal(attempt.history[0].status===0,false,'the first run already survived; retrying would launder it: '+mutant.file+'\n'+(attempt.history[
        0].stdout+attempt.history[0].stderr));
      assert.notEqual(result.status,0,'surviving mutant: '+mutant.file+evidence+(attempt.retried?'\nfirst run:\n'+firstRunTail(attempt.history[0]):''));
      assert.match(output,/AssertionError/,'a parser/import failure does not kill a behavioral mutant'+evidence);
      assert(output.split('\n').some(line=>line.startsWith('not ok ') && line.includes(mutant.killedBy)),
        'the intended regression must FAIL: '+mutant.killedBy+evidence);
    }
    const changed=drift(baselineFiles,manifestOf(path.join(dir,'packages')));
    assert.deepEqual(changed,[],'the restored tree differs from the tree that produced the green baseline: '+changed.slice(0,5).join(', '));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
