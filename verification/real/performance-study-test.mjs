import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/**
 * Offline regression for the opt-in performance stage's tool surface.
 *
 * The request catalog advertises the harness's real_work tool to every member. The stage's own members are created by
 * the study rather than enrolled from the roster, so they have to be wired the same way: this suite drives the fake
 * transport, which calls real_work brief from every study member, and requires that the call executes as the harness's
 * business tool. Before that wiring the member's tool guard saw an unknown native effect and refused the call with
 * UNKNOWN_EFFECT, which is exactly what metrics.assertions.nativeToolProtocol reports as a protocol failure.
 *
 * It runs at a reduced size: the fake transport is functional evidence only and the gate reports not-run for it, so the
 * suite checks the tool path, not a live sample count. The study stage still runs its real cycles end to end.
 */
const root = path.resolve(process.argv[2] ?? '');
assert(root && !fs.existsSync(root), 'usage: performance-study-test.mjs <new absolute root>');
const here = path.dirname(fileURLToPath(import.meta.url));
const run = spawnSync(process.execPath, [path.join(here, 'run.mjs'), 'performance', '--fake-provider', '--root', root], {
  encoding: 'utf8',
  timeout: 300000,
  env: {...process.env, DSH_PERF_FAKE_SMALL: '1'},
});
assert.equal(run.status, 0, 'performance stage exit=' + run.status + '\n' + String(run.stdout ?? '') + String(run.stderr ?? ''));
const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(root, 'facts.json'), 'utf8'));
assert.equal(report.realProviderRequests, 0, 'the fake transport makes no provider request');
assert.equal(report.status, 'passed', 'report status: ' + report.status + ' ' + JSON.stringify(report.error));
assert.equal(report.metrics.performance.status, 'not-run', 'a fake run never claims a measured performance result');
assert.equal(report.metrics.assertions.nativeToolProtocol, true, 'real_work must not be refused as an unknown effect');
assert.deepEqual(report.metrics.protocol.errors, [], 'no protocol error may be recorded');
assert.equal(report.cleanup && report.ports.every(port => port.closed), true, 'ports must be closed');
const actions = (facts.toolActions ?? []).filter(row => row.name === 'real_work' && row.args?.op === 'brief');
assert(actions.length > 0, 'the scripted member called real_work brief and the call completed');
assert(actions.every(row => row.actor !== 'member:root'), 'the study members, not root, exercised the tool');
assert((facts.performanceStudy?.samples ?? []).length > 0, 'the study recorded samples');
console.log('performance study PASS: ' + actions.length + ' real_work brief calls completed, 0 protocol errors, ' +
  (facts.performanceStudy.samples.length) + ' samples recorded (fake: gate not-run)');
