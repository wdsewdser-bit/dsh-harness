import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { webOverlay } from '../../packages/profiles/web.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';
import { ControlStore } from '../../packages/store/index.mjs';
import { pollProjection } from '../fixtures/p4-web-poll.mjs';
import { saveFailure } from '../failure-diagnostics.mjs';
/** Exercise the C1+C2 web profile on isolated loopback ports, then stop it; 08 §5. */
export async function webTest(root, { team = true, port = 40291, keepAlive = false } = {}) {
  // The host runs with cwd = root, so a relative root would be resolved twice (once here, once by the loader).
  root = path.resolve(root);
  const token = randomBytes(24).toString('hex');
  const patch = webOverlay(root, { token, team });
  const entries = JSON.parse(fs.readFileSync(patch));
  if (team) {
    // The scripted run (public commands + host dispatch, no test-side driver) produces the member turns and their
    // context rows, then the fixture commits every Team surface the UI has a view for (collecting thread, both unknown
    // kinds, approval, retirable members, prepared completion token). Both run through ordinary role commands; the
    // fixture is last because its token freezes writes.
    const client = entries[0].insert.findIndex(entry => entry.id === 'client-team');
    entries[0].insert.splice(client, 0,
      { id: 'p4-scenario', name: new URL('./p4-scenario-plugin.mjs', import.meta.url).href, config: { root } },
      { id: 'p4-fixture', name: new URL('./p4-fixture-plugin.mjs', import.meta.url).href, config: { root, after: 'scenario' } });
  }
  fs.writeFileSync(patch, JSON.stringify(entries));
  const env = { ...process.env, DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|PROXY|DSH_HOST_NODE|DSH_RUNTIME_DIR/i.test(key)) delete env[key];
  // The web host is the one the selected build ships, never a path typed here: DSH_UPSTREAM_BUILD decides, so the
  // same script covers the 0.2.2-alpha.2 C1 build (previous release) and both 0.2.2-rc.1 builds instead of pinning the
  // harness to one copy of the release.
  const { base } = buildTarget();
  const child = spawn(process.execPath, [base + 'dsh/lib/bin.js', '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port',
      String(port)], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const state = { pid: child.pid, web: port, projection: team ? 40292 : null, status: 'starting', loginUrl: null };
  const stateFile = root + '/runtime.json';
  const save = () => {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
    for (let retry = 0; ; retry++) {
      try { fs.renameSync(stateFile + '.tmp', stateFile); return; }
      catch (error) { if (!['EPERM','EBUSY','EACCES'].includes(error.code) || retry >= 20) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
    }
  };
  fs.writeFileSync(root + '/web.log', JSON.stringify(state) + '\n'); save();
  const capture = x => {
    log += x; fs.appendFileSync(root + '/web.log', x);
    const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
    if (url) state.loginUrl = url[0]; save();
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    // Three member turns (created and driven by the host) have to finish before the fixture commits, and a cold host
    // takes most of a minute on Windows, so the deadline is generous rather than tuned: a slower machine must not read
    // as a missing surface.
    const end = Date.now() + (Number(process.env.P4_WEB_TIMEOUT_MS) || 180000);
    let snapshot;
    if (!team) {
      let status;
      while (Date.now() < end && child.exitCode === null) {
        try { status = (await fetch('http://127.0.0.1:' + port)).status; if (status === 401) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.equal(status, 401, log.slice(-2000));
      assert.deepEqual(entries[0].insert, []);
      assert(!fs.existsSync(root + '/state-v2'));
      assert(!fs.existsSync(root + '/client-team-real'));
      return { webStatus: status, defaultNoTeam: true };
    }
    // The fixture's prepared completion token is the last commit, so a snapshot that shows it has every earlier row.
    ({ snapshot } = await pollProjection({ url: 'http://127.0.0.1:40292/team/projection/snapshot', token,
      deadline: end, alive: () => child.exitCode === null,
      onPoll: last => { state.projectionPoll = last; } }));
    // Three notices the scripted run recorded for its three members, two from the fixture (the unknown one and the
    // observed one).
    assert.equal(snapshot?.data.messages.length, 5, log.slice(-3000));
    assert.equal(snapshot?.data.goal.completionToken, 'prepared', log.slice(-3000));
    const page = await fetch('http://127.0.0.1:40291'); assert.equal(page.status, 401); // Native web authentication remains enabled; no credential bypass.
    // M1b identity: the envelope carries the composite principal the bearer token was bound to (teamId + the local
    // memberId, design §8.3.4), not a bare member id. Pinning both halves is stricter than the old string compare.
    assert.equal(snapshot.viewer.memberId, 'member:root');
    assert.equal(snapshot.viewer.teamId, snapshot.teamId);
    assert.equal(snapshot.data.goal.status, 'known'); assert.equal(snapshot.data.goal.native.phase, 'paused');
    assert.equal(snapshot.data.goal.gate.status, 'blocked');
    for (const name of ['a', 'b', 'v']) {
      const member = snapshot.data.members.find(m => m.id === 'member:' + name);
      assert.equal(member.contextStatus.status, 'known'); assert.equal(member.context.window, 100000);
      assert.equal(member.context.inputTokens, 100); assert.equal(member.context.pct, 100 / 75000 * 100);
    }
    // The owner member has no native execution, so it has no context sample to report - and that is the truth the
    // panel must show rather than a zero: root is the session that owns the team, not a member agent.
    assert.equal(snapshot.data.members.find(m => m.id === 'member:root').contextStatus.status, 'unknown');
    // Root is the owner session, not a member agent, so it has no nativeRef - and the projection no longer reads that
    // absence as "requested". The team's owner session is registered with the router for as long as the host runs,
    // and the product projection reads that binding: a bound, live owner session means the member is active (there is
    // a running session driving the team), and only an unbound one falls back to the row-derived answer. Before this
    // the panel told the operator its lead member had never arrived, which is the opposite of the truth here.
    assert.equal(snapshot.data.members.find(m => m.id === 'member:root').observed, 'active');
    // The fixture surfaces, asserted from the same snapshot a browser reads.
    assert(snapshot.data.threads.some(t => t.state === 'collecting'));
    assert(snapshot.data.unknownEffects.some(u => u.id.startsWith('message:')));
    assert(snapshot.data.unknownEffects.some(u => u.kind === 'delivery'));
    assert.equal(snapshot.data.approvals.filter(a => a.status === 'requested').length, 1);
    assert(!fs.existsSync(root + '/client-team-real'));
    const entry = entries[0].insert.find(e => e.id === 'client-team');
    assert.equal(entry.config.source, 'http'); assert.equal(entry.config.viewer, undefined);
    fs.writeFileSync(root + '/snapshot.json', JSON.stringify(snapshot, null, 2));
    state.status = 'ready'; save();
    console.log('P4_RUNTIME ' + JSON.stringify(state));
    if (keepAlive) {
      fs.writeFileSync(root + '/keep-alive.json', JSON.stringify({ pid: child.pid, web: port, projection: 40292 }));
      console.log('KEEP_ALIVE: web 127.0.0.1:' + port + ', Ctrl+C to stop; native login required');
      await new Promise(resolve => {
        const stopFile = root + '/STOP';
        const timer = setInterval(() => { if (fs.existsSync(stopFile)) done(); }, 100);
        const done = () => { clearInterval(timer); process.removeListener('SIGINT', done); process.removeListener('SIGTERM', done); resolve(); };
        process.once('SIGINT', done); process.once('SIGTERM', done); child.once('exit', done);
        console.log('Clean stop: create ' + stopFile);
      });
    }
    return { webStatus: page.status, realMembers: snapshot.data.members.length, realMessages: snapshot.data.messages.length, seq: snapshot.asOfSeq };
  } catch (error) {
    const diagnostics = { poll: error.projectionPoll ?? state.projectionPoll ?? null, storage: null, storageError: null };
    let store;
    try {
      store = ControlStore.openReadOnly(root);
      const events = store.events();
      diagnostics.storage = { messageRows: store.list('message:').length, journalSeqs: events.map(event => event.seq),
        journalHead: store.latestEventSeq(), retention: store.storageStatus().authoritativeEvidenceRetention,
        readers: store.readers() };
    } catch (failure) { diagnostics.storageError = { code: failure.code ?? null, message: failure.message }; }
    finally { try { store?.close(); } catch (failure) { error.cleanupErrors = [...(error.cleanupErrors ?? []), failure]; } }
    const saved = saveFailure({ label: 'p4-web-projection', output: log, error, metadata: { projection: diagnostics } });
    error.message += '\nP4_PROJECTION_FAILURE ' + JSON.stringify(diagnostics) + '\ndiagnostics=' + saved;
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    state.status = 'stopped'; state.exitCode = child.exitCode; save();
    fs.appendFileSync(root + '/web.log', '\n' + JSON.stringify(state) + '\n');
    fs.rmSync(root + '/keep-alive.json', { force: true });
  }
}
