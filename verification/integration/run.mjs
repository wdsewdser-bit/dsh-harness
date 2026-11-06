import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { upstream } from '../../packages/adapter-dsh/index.mjs';
import { faults } from './faults.mjs';
import { p3Regressions, p3Core } from '../domain/p3-tests.mjs';
import { p3Team } from '../domain/p3b-tests.mjs';
import { modelContracts } from '../domain/p3b-model.mjs';

const [suite, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  options[args[i].replace(/^--/, '')] = args[i + 1];
}
const base = fileURLToPath(new URL('.', import.meta.url));
const report = { suite, startedAt: new Date().toISOString(), status: 'failed' };
const requested = options.report ?? path.join(base, '..', '..', 'reports', suite + '.json');
const inside = candidate => path.resolve(candidate).split(path.sep).join('/')
  .toLowerCase().startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/');
const outputPath = inside(requested)
  ? requested
  : path.join(base, '..', '..', 'reports', 'invalid-path.json');

try {
  assert(options.root, '--root required');
  assert(
    path.resolve(options.root).split(path.sep).join('/').toLowerCase().startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/'),
    'root must be inside sole write domain',
  );
  assert(!fs.existsSync(options.root) || fs.readdirSync(options.root).length === 0, 'root must be new and empty');
  assert.equal(options.profile ?? 'default', suite.startsWith('p3-') ? 'team' : 'default');
  assert.equal(options.fold ?? 'off', 'off');
  fs.mkdirSync(options.root, { recursive: true });
  const moduleNames = [
    'dsh-session-projection',
    'dsh-session',
    'dsh-llm',
    'dsh-tools',
    'dsh-system-prompt',
    'dsh-agent',
    'dsh-token-meter',
    'dsh-session-persistence-jsonl',
    'dsh-agent-loop',
    'dsh-compaction-basic',
  ];
  const frozen = {
    schemaVersion: 1,
    upstream: upstream.version,
    adapter: 'p2-offline-v1',
    featureFlags: { fold: false, providerReplay: false },
    modules: Object.fromEntries(moduleNames.map(moduleName => {
      const modulePath = upstream.root + moduleName + '/lib/index.js';
      const contentHash = createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
      return [moduleName, contentHash];
    })),
  };
  if (options.manifest) {
    const expected = JSON.parse(fs.readFileSync(options.manifest));
    assert.deepEqual(frozen, expected, 'upstream manifest drift');
  }
  fs.writeFileSync(options.root + '/manifest.json', JSON.stringify(frozen, null, 2));
  report.manifest = options.root + '/manifest.json';
  if (suite === 'p2-context') {
    for (const mode of ['hot', 'cold']) {
      const child = spawnSync(process.execPath, [base + 'host.mjs', mode, options.root], {
        encoding: 'utf8', timeout: 180000,
      });
      fs.writeFileSync(
        options.root + '/' + mode + '-command.txt',
        child.stdout + String.fromCharCode(10) + child.stderr,
      );
      assert.equal(child.status, 0, child.stderr);
      console.log(child.stdout.trim());
    }
    const hot = JSON.parse(fs.readFileSync(options.root + '/hot.json'));
    const cold = JSON.parse(fs.readFileSync(options.root + '/cold.json'));
    assert(hot.wires.every(wire => wire.I < 0.75 * wire.W && wire.I + wire.R + wire.M <= wire.W));
    const failRoot = options.root + '/summary-fail';
    for (const mode of ['summary-fail', 'cold']) {
      const child = spawnSync(process.execPath, [base + 'host.mjs', mode, failRoot], {
        encoding: 'utf8', timeout: 180000,
      });
      assert.equal(child.status, 0, child.stderr);
      console.log(child.stdout.trim());
    }
    const failed = JSON.parse(fs.readFileSync(failRoot + '/hot.json'));
    assert(failed.blocked && failed.main === 35 && failed.aux === 1);
    Object.assign(report, {
      main: hot.main,
      aux: hot.aux,
      executions: hot.executions,
      cold,
      nativeReplaceSerialization: hot.nativeReplaceSerialization,
      explicitRetryGate: hot.explicitRetryGate,
      summaryFailure: {
        blocked: true,
        inputRecoverable: true,
        cold: JSON.parse(fs.readFileSync(failRoot + '/cold.json')),
      },
      optionalFolds: hot.optionalFolds,
    });
  } else if (suite === 'p3-regressions') {
    Object.assign(report, await p3Regressions(options.root, options.families));
  } else if (suite === 'p3-model-contracts') {
    Object.assign(report, await modelContracts(options.root, options.scenario));
  } else if (suite === 'p3-team') {
    Object.assign(report, await p3Team(options.root, options.faults === 'all'));
  } else if (suite === 'p3-core') {
    Object.assign(report, { protocol: await p3Core(options.root) });
  } else if (suite === 'p2-faults') {
    Object.assign(report, await faults(options.root));
  } else {
    throw Error('unknown suite');
  }
  report.status = 'passed';
  console.log(suite + ': PASS ' + JSON.stringify(report));
} catch (error) {
  report.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
}
