import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildTarget } from '../../adapter-dsh/index.mjs';

// Run only the S3 suite in an isolated source copy. Never mutate the live tree or weaken its assertions.
test('S3 review mutations are killed by behavioral assertions, not import failures', {timeout:180000}, () => {
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-s3-mutations-'));
  try {
    fs.cpSync(path.join(repo,'packages'),path.join(dir,'packages'),{recursive:true,
      filter:source=>!['node_modules','.scratch'].includes(path.basename(source))});
    fs.mkdirSync(path.join(dir,'runs'),{recursive:true});
    // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot
    // name the pristine install the adapter composes.
    fs.mkdirSync(path.join(dir,'build'),{recursive:true});
    fs.copyFileSync(path.join(repo,'build','builds.json'),path.join(dir,'build','builds.json'));
    const env={...process.env,FORCE_COLOR:'0',DSH_UPSTREAM_BUILD:buildTarget().build};
    delete env.NODE_TEST_CONTEXT;
    const run=(...suites)=>{suites=suites.filter(Boolean);return spawnSync(process.execPath,['--test','--test-reporter=tap',
      ...(suites.length?suites:['packages/core/test/superagent-borrow-s3.test.mjs','packages/core/test/superagent-borrow-s3-review.test.mjs'])],
      {cwd:dir,encoding:'utf8',timeout:60000,env});};
    const baseline=run();
    assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
    assert.match(baseline.stdout,/# tests (?:[1-9]\d*)/);
    assert.match(baseline.stdout,/# fail 0/);
    const boundary='packages/profiles/test/superagent-borrow-s3-boundary.test.mjs';
    const integrationBaseline=run(boundary);
    assert.equal(integrationBaseline.status,0,integrationBaseline.stdout+integrationBaseline.stderr);
    assert.match(integrationBaseline.stdout,/# tests (?:[1-9]\d*)/);
    assert.match(integrationBaseline.stdout,/# fail 0/);
    const mutants=[
      // v1 falls back to the legacy step seam: the arbiter would call preemptStep on a live turn.
      {file:'packages/core/preempt.mjs',old:"    if (this.policy === 'queue') return this.queuedOutcome(memberId, agent);",
        replacement:"    // mutant: no queue strategy",killedBy:'B05/B07'},
      {file:'packages/core/preempt.mjs',old:"return { fired: false, reason: 'infoOnly', dispatched: false, wake: 'carried' };",
        replacement:"return { fired: false, reason: 'infoOnly', dispatched: true, wake: 'carried' };",killedBy:'B05 review'},
      {file:'packages/core/inputs.mjs',old:'  return E ? Boolean(init.E && sameExecution(init.E, E)) : !init.E;',
        replacement:'  return true;',killedBy:'B02/B03 review'},
      // The ordering stops preferring human control.
      {file:'packages/core/inputs.mjs',old:'const stable = list => [...list].sort((a, b) => (a.priority - b.priority) ||',
        replacement:'const stable = list => [...list].sort((a, b) => 0 ||',killedBy:'B04'},
      // The 4096 ceiling stops being enforced.
      {file:'packages/core/snapshot.mjs',old:
        '    const fits = Buffer.byteLength(renderBatchText(payloadOf(chosen, ordered.length - chosen.length))) * 2 <= limit;',
        replacement:'    const fits = true;',killedBy:'B01/B04'},
      // A tampered subscription epoch is accepted as evidence.
      {file:'packages/core/provenance.mjs',old:'export function verifyInputBinding(read, binding, owner) {',
        replacement:'export function verifyInputBinding(read, binding, owner) { return read(binding.ref);',killedBy:'B03'},
      // The watermark steps over a hole.
      {file:'packages/core/provenance.mjs',old:
        "    if (!['visible', 'superseded'].includes(row.state) || row.seq !== Math.max(through, sub.startAfterSeq ?? 0) + 1) break;",
        replacement:'    // mutant: cross every hole',killedBy:'B04'},
      {file:'packages/host/src/visibility/dispatch.mjs',
        old:'(batchMode && routeKey(live) !== slot.routeKey)',replacement:'false',suite:boundary,killedBy:'B02 real evidence'},
      {file:'packages/profiles/runtime.mjs',
        old:"if (typeof control?.run !== 'function') return { deferred: true, reason: 'owner control capacity unavailable (P4)' };",
        replacement:"if (typeof control?.run !== 'function') return { executed: true };",suite:boundary,killedBy:'B07 real owner'},
      {file:'packages/core/commands/messages.mjs',
        old:"if (isCoordinationIntent(current) && current.status === 'open') {",
        replacement:'if (false) {',suite:boundary,killedBy:'B07 real owner'},
      {file:'packages/adapter-dsh/build-target.mjs',
        old:'if (!boundaryWakeOnly && (!sourceHas(loop,',replacement:'if (true && (!sourceHas(loop,',suite:boundary,killedBy:'B06 review'},
    ];
    for(const mutant of mutants) {
      const file=path.join(dir,mutant.file),original=fs.readFileSync(file,'utf8');
      assert.equal(original.split(mutant.old).length-1,1,'unique mutation site: '+mutant.file);
      try {
        fs.writeFileSync(file,original.replace(mutant.old,mutant.replacement));
        const result=run(mutant.suite),output=result.stdout+result.stderr;
        assert.equal(result.error,undefined,String(result.error));
        assert.notEqual(result.status,0,'surviving mutant: '+mutant.file);
        assert.doesNotMatch(output,/SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|Cannot access '/,
          'a parser/import failure does not kill a behavioral mutant');
        assert(output.split('\n').some(line=>line.trimStart().startsWith('not ok ') && line.includes(mutant.killedBy)),
          'the intended regression must FAIL: '+mutant.killedBy);
      } finally { fs.writeFileSync(file,original); }
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
