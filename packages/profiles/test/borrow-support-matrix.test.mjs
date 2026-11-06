import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildTarget } from '../../adapter-dsh/index.mjs';
import { cleanupDirs, cleanupOrThrow } from '../test-support/temp-roots.mjs';

/**
 * Gap 2 of docs/decisions/superagent-borrow-integration.md: the public-entry support matrix.
 *
 * The candidate is a deliberately isolated copy in which only the implementation gate is flipped to 'implemented'. The
 * baseline must be nonzero and green; every mutant must be killed by a behavioral assertion (exit 1, ERR_ASSERTION, no
 * syntax/import failure). This is a candidate build, never a production activation flag.
 */
const restart = 'matrix: restart keeps';
const declaration = 'matrix: one supported build';
const transport = 'matrix: an uncontrolled transport';

/**
 * Copy the package files listed by Git one by one, not a recursive glob of the workspace at an arbitrary instant.
 * Every listed file must exist, be a regular file inside packages and be byte-verified after copying; a missing path is
 * reported by path instead of surfacing later as ERR_MODULE_NOT_FOUND inside the isolated candidate.
 */
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function copyPackagesClosure(repo, root) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages'],
    { cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(listed.status, 0, 'git ls-files failed: ' +
    (listed.error ? listed.error.message + '; ' : '') + listed.stderr);
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))];
  assert(files.includes('packages/contracts/team.mjs'), 'packages/contracts/team.mjs is part of the profiles dependency closure');
  assert(files.includes('packages/profiles/borrow-entry-support.mjs'), 'new profile files are included as untracked closure files');
  const sourcePackages = fs.realpathSync(path.join(repo, 'packages'));
  const destPackages = path.resolve(root, 'packages');
  for (const relative of files) {
    assert(relative.startsWith('packages/') && !relative.split('/').includes('..'),
      'manifest path escapes packages: ' + relative);
    const from = path.resolve(repo, relative), to = path.resolve(root, relative);
    assert(within(sourcePackages, from), 'manifest path escapes repository packages: ' + relative);
    assert(within(destPackages, to), 'destination escapes isolated packages: ' + relative);
    assert(fs.existsSync(from), 'dependency file is missing from the workspace: ' + relative);
    const stat = fs.lstatSync(from);
    assert(stat.isFile() && !stat.isSymbolicLink(),
      'dependency closure must contain regular files, not symlinks or junctions: ' + relative);
    assert(within(sourcePackages, fs.realpathSync(from)),
      'dependency file resolves outside repository packages: ' + relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    assert(fs.readFileSync(from).equals(fs.readFileSync(to)), 'copy is not byte-identical: ' + relative);
  }
  return files.length;
}

test('public-entry support matrix: isolated baseline green, every critical guard killed by behavior', { timeout: 300000 }, async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-matrix-suite-'));
  const childTemp = path.join(root, 'child-temp');
  fs.mkdirSync(childTemp, { recursive: true });
  let privateBuild = null;
  let primary = null;
  try {
    const copied = copyPackagesClosure(repo, root);
    assert(copied >= 300, 'the isolated copy must contain the full packages closure');
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
    // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot name
  // the pristine install the adapter composes.
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'build', 'builds.json'), path.join(root, 'build', 'builds.json'));
    const contract = path.join(root, 'packages/contracts/superagent-borrow.mjs');
    const source = fs.readFileSync(contract, 'utf8');
    assert.equal(source.split("v1: 'contract-only'").length, 2);
    fs.writeFileSync(contract, source.replace("v1: 'contract-only'", "v1: 'implemented'"));
    const env = { ...process.env, FORCE_COLOR: '0', DSH_UPSTREAM_BUILD: buildTarget().build,
      TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp };
    delete env.NODE_TEST_CONTEXT;
    // The prepared build is a shared artifact of the whole suite. A mutation run must never write it: create an
    // exclusive physical copy of dsh-llm inside a private build root (everything else is a junction to the read-only
    // source packages) and point DSH_UPSTREAM_BUILD at that copy.
    const sharedBase = buildTarget().base;
    const sharedLlm = path.join(sharedBase, 'dsh-llm/lib/index.js');
    const sharedSource = fs.readFileSync(sharedLlm, 'utf8');
    const sharedHash = createHash('sha256').update(sharedSource).digest('hex');
    for (const marker of ['EXECUTION_PERMIT_CONTRACT', 'withExecutionCall', 'isExecutionTargetTrusted', 'execution-permit/1']) {
      assert(sharedSource.includes(marker), 'the prepared build lost its enforcement marker before the mutation run: ' + marker);
    }
    privateBuild = fs.mkdtempSync(path.join(root, 'private-build-'));
    try {
      const privateModules = path.join(privateBuild, 'node_modules');
      const privateBase = path.join(privateModules, '@deepseek-ai');
      fs.mkdirSync(privateBase, { recursive: true });
      // Third-party packages stay read-only junctions; only repository-owned code is physical. Without these, a
      // physically copied @deepseek-ai package would resolve its external dependencies outside the private tree.
      for (const entry of fs.readdirSync(path.dirname(sharedBase), { withFileTypes: true })) {
        if (entry.name === '@deepseek-ai') continue;
        const from = path.join(path.dirname(sharedBase), entry.name), to = path.join(privateModules, entry.name);
        if (entry.isDirectory()) fs.symlinkSync(fs.realpathSync(from), to, 'junction');
        else fs.copyFileSync(from, to);
      }
      // Every package's code (package.json + lib) is a physical copy, so each module resolves its dependencies from
      // this private tree and there is no second-module split back to the shared dsh-llm. Assets and other entries are
      // read-only junctions; the harness never writes them.
      for (const entry of fs.readdirSync(sharedBase, { withFileTypes: true })) {
        const from = path.join(sharedBase, entry.name), to = path.join(privateBase, entry.name);
        fs.mkdirSync(to);
        for (const child of fs.readdirSync(from, { withFileTypes: true })) {
          const childFrom = path.join(from, child.name), childTo = path.join(to, child.name);
          if (child.name === 'lib' || child.name === 'package.json') {
            fs.cpSync(childFrom, childTo, { recursive: true, dereference: true });
          } else if (child.isDirectory()) {
            fs.symlinkSync(fs.realpathSync(childFrom), childTo, 'junction');
          } else {
            fs.copyFileSync(childFrom, childTo);
          }
        }
      }
      assert.equal(buildTarget(privateBuild).version, buildTarget().version);
      const privateLlmPath = path.join(privateBase, 'dsh-llm/lib/index.js');
      const sharedModule = await import(pathToFileURL(sharedLlm).href);
      const privateModule = await import(pathToFileURL(privateLlmPath).href);
      assert.notEqual(privateModule, sharedModule, 'the private build must load its own dsh-llm module');
      assert.notEqual(fs.realpathSync(privateLlmPath), fs.realpathSync(sharedLlm));
      const privateRequire = createRequire(path.join(privateBase, 'dsh-agent-loop/lib/index.js'));
      const resolved = privateRequire.resolve('@deepseek-ai/dsh-llm');
      assert.equal(fs.realpathSync(resolved), fs.realpathSync(privateLlmPath),
        'the private agent-loop must resolve the private dsh-llm, not the shared package');
    } catch (error) {
      const errors = cleanupDirs([privateBuild]);
      if (errors.length) error.cleanupErrors = errors;
      throw error;
    }
    const privateEnv = { ...env, DSH_UPSTREAM_BUILD: privateBuild };
    const privateLlm = path.join(privateBuild, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js');
    // Run the candidate file directly: node:test executes it in this one process, so the mutant harness adds no extra
    // test-runner process (one candidate + one crash worker at a time).
    const childResidue = () => fs.readdirSync(childTemp).filter(name => name.startsWith('borrow-'));
    const spawn = (pattern, runEnv = env) => {
      const result = spawnSync(process.execPath, ['packages/profiles/test-support/borrow-support-matrix.mjs'],
        { cwd: root, env: pattern ? { ...runEnv, MATRIX_ONLY: pattern } : runEnv, encoding: 'utf8', timeout: 240000,
          maxBuffer: 8 * 1024 * 1024 });
      assert.deepEqual(childResidue(), [], 'child left borrow-* under its parent temp root');
      return result;
    };
    const baseline = spawn(null);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.match(baseline.stdout, /(#|ℹ) pass 3/);
    assert.match(baseline.stdout, /(#|ℹ) fail 0/);
    assert.match(baseline.stdout, /(#|ℹ) skipped 0/);
    const run = (pattern, runEnv = env) => spawn(pattern, runEnv);
    // Same private build, no mutation: this must be green before the mutant proves anything. A module split or a
    // private-build behaviour difference would show up here, not as a false kill.
    const privateBaseline = run(transport, privateEnv);
    assert.equal(privateBaseline.status, 0, privateBaseline.stdout + privateBaseline.stderr);
    assert.match(privateBaseline.stdout, /(#|ℹ) pass 1/);
    assert.match(privateBaseline.stdout, /(#|ℹ) fail 0/);
    assert.match(privateBaseline.stdout, /(#|ℹ) skipped 2/);

    const mutants = [
      ['core/control-capacity.mjs', "state:terminal?'released':'unknown'", "state:'released'", restart, 'recovery marks H unknown'],
      ['core/control-capacity.mjs', 'admissionClosed:used.unknown>0', 'admissionClosed:false', restart, 'unknown closes admission'],
      ['profiles/llm-execution.mjs', "typeof verifyTerminated!=='function'||await verifyTerminated({slot:structuredClone(slot),evidenceRef})!==true",
        'false', restart, 'owner proof required'],
      ['profiles/llm-execution.mjs', ["slot.state==='released'||", 'requireLive:true'], ['', 'requireLive:false'], restart, 'owner reclaim replay'],
      ['host/src/effect-runner.mjs', "if (typeof verifyStopped !== 'function' || typeof evidenceRef !== 'string' || !evidenceRef ||", 'if (false &&',
        restart, 'effect proof required'],
      ['host/src/effect-runner.mjs', 'teamId: slot.teamId ?? null, hostEpoch: slot.hostEpoch ?? null, attemptId: slot.attemptId ?? null',
        'teamId: null, hostEpoch: null, attemptId: slot.attemptId ?? null', restart, 'proof binds claim team/epoch'],
      ['host/src/effect-runner.mjs', 'if (ioDone && closeDone && (!capacityLanes || slot.terminal)', 'if (true', restart, 'timeout does not free IO'],
      ['host/src/effect-runner.mjs', 'stop() { stopped = true;', 'stop() { stopped = true; activeIO.clear();', restart, 'runner.stop does not free IO'],
      ['profiles/borrow-entry-support.mjs', 'const absent = EXECUTION_PERMIT_MARKERS.filter(marker => !source.includes(marker));', 'const absent = [];',
        declaration, 'execution-permit capability required'],
      ['profiles/borrow-entry-support.mjs', 'if (target.version !== declared) {', 'if (false) {', declaration, 'declared version enforced'],
      ['profiles/borrow-entry-support.mjs', 'target.boundaryWake?.stepAbort !== true', 'false', declaration, 'instant-preempt surface enforced'],
      ['profiles/borrow-entry-support.mjs', 'if (module.isExecutionTargetTrusted(transport) !== true) {', 'if (false) {', declaration,
        'registry trust is not self-reported'],
      ['profiles/borrow-entry-support.mjs', 'const declared = transport.executionPermitContract;', 'const declared = BORROW_TRANSPORT_CONTRACT;',
        declaration, 'current declaration after registration'],
      ['profiles/borrow-entry-support.mjs', 'if (module.isExecutionTargetTrusted(transport) !== true) {',
        'if (transport.executionPermitContract && module.isExecutionTargetTrusted(transport) !== true) {', declaration, 'unregistered getter not executed'],
      ['profiles/borrow-entry-support.mjs',
        ['  let module;\n',
          "  // Registered identity is established; only now read the current declaration, synchronously, so re"+
          "gistration and\n  // contract describe the same instant.\n  const declared = transport.executionPermit"+"Contract;\n"],
        ['  const declared = transport.executionPermitContract;\n  let module;\n',
          "  // Registered identity is established; only now read the current declaration, synchronously, so re"+
          "gistration and\n  // contract describe the same instant.\n"],
        declaration, 'contract read after registration', 1, /the current declaration, not the pre-await one/],
      ['profiles/borrow-entry-support.mjs',
        "    // Do not touch the transport here: an invalid build must not execute an unregistered object's g"+
          "etter.\n    return Object.freeze({ supported: false, code: error?.code ?? 'PATCH_MISSING',\n      reas"+
          "on: String(error?.message ?? error), build: build ?? null, transport: null, runtimeTrust: 'unavailab"+"le' });",
        "    const declared = transport?.executionPermitContract;\n    return Object.freeze({ supported: false"+
          ", code: error?.code ?? 'PATCH_MISSING',\n      reason: String(error?.message ?? error), build: build "+
          "?? null, transport: declared ?? null, runtimeTrust: 'unavailable' });",
        declaration, 'build-error branch reads getter', 1, /a build refused before the transport must not read its contract/],
    ];
    for (const [file, oldText, newText, pattern, killed, occurrences = 1, specific = null] of mutants) {
      const target = path.join(root, 'packages', file);
      const original = fs.readFileSync(target, 'utf8');
      const olds = Array.isArray(oldText) ? oldText : [oldText];
      const news = Array.isArray(newText) ? newText : [newText];
      let mutated = original;
      for (let index = 0; index < olds.length; index += 1) {
        assert.equal(mutated.split(olds[index]).length, occurrences + 1,
          occurrences + ' mutant anchor(s) in ' + file + ': ' + olds[index]);
        mutated = occurrences === 1 ? mutated.replace(olds[index], news[index])
          : mutated.split(olds[index]).join(news[index]);
      }
      fs.writeFileSync(target, mutated);
      let result;
      try { result = run(pattern); } finally { fs.writeFileSync(target, original); }
      const output = result.stdout + result.stderr;
      assert.equal(result.error, undefined, 'mutant run failed to start: ' + killed);
      assert.equal(result.signal, null, 'mutant was killed by a signal: ' + killed);
      assert.equal(result.status, 1, 'surviving mutant (' + killed + '): ' + output.slice(-4000));
      assert.match(output, /ERR_ASSERTION/, 'mutant died for the wrong reason: ' + killed);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
      assert(/not ok|✖/.test(output) && output.includes(pattern), 'wrong case killed: ' + killed);
      if (specific) assert.match(output, specific, 'mutant was not killed by the required assertion: ' + killed);
    }
    // The transport authority is enforced twice: by the profile (packages/profiles/llm-execution.mjs) and by the
    // prepared build's execution-permit patch. Reversing one layer alone leaves the other in force, so both are reversed
    // together. The build half is reversed only in the exclusive private copy; the shared prepared build is never
    // written and its hash is checked again below.
    const buildOriginal = fs.readFileSync(privateLlm, 'utf8');
    assert.equal(buildOriginal, sharedSource);
    const profileFile = path.join(root, 'packages/profiles/llm-execution.mjs');
    const profileOriginal = fs.readFileSync(profileFile, 'utf8');
    const profileMutant = profileOriginal.split('!module.isExecutionTargetTrusted?.(target)').join('false')
      .split('target?.executionPermitContract!==BORROW_TRANSPORT_CONTRACT').join('false');
    assert.notEqual(profileMutant, profileOriginal);
    const buildMutant = buildOriginal
      .split('(!isExecutionTargetTrusted(target) || target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)').join('(false)')
      .split('(!isExecutionTargetTrusted(adapter) || adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)').join('(false)')
      .split('(!isExecutionTargetTrusted(adapter) || adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)').join('(false)');
    assert.notEqual(buildMutant, buildOriginal);
    let transportResult;
    try {
      fs.writeFileSync(privateLlm, buildMutant);
      fs.writeFileSync(profileFile, profileMutant);
      transportResult = run(transport, privateEnv);
    } finally {
      fs.writeFileSync(privateLlm, buildOriginal);
      fs.writeFileSync(profileFile, profileOriginal);
    }
    assert.equal(createHash('sha256').update(fs.readFileSync(sharedLlm, 'utf8')).digest('hex'), sharedHash,
      'the shared prepared build was modified by the mutation run');
    const transportOutput = transportResult.stdout + transportResult.stderr;
    assert.equal(transportResult.signal, null);
    assert.equal(transportResult.status, 1, 'surviving transport mutant: ' + transportOutput.slice(-4000));
    assert.match(transportOutput, /ERR_ASSERTION/);
    assert.match(transportOutput, /no provider request is made|unregistered execution target is never asked for a request/,
      'the transport mutant must die on the no-request security assertion: ' + transportOutput.slice(-2000));
    assert(/not ok|✖/.test(transportOutput) && transportOutput.includes(transport));
    const restoredBaseline = run(transport, privateEnv);
    assert.equal(restoredBaseline.status, 0, restoredBaseline.stdout + restoredBaseline.stderr);
    assert.match(restoredBaseline.stdout, /(#|ℹ) pass 1/);
    assert.match(restoredBaseline.stdout, /(#|ℹ) fail 0/);
    console.log('public-entry support matrix: 3 shared baseline cases; private-build clean baseline before/after; ' +
      mutants.length + ' source mutants + the two-layer transport mutant killed by behavioral assertions');
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    cleanupOrThrow([root, privateBuild].filter(Boolean), primary);
  }
});
