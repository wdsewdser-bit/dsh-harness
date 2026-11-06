import fs from 'node:fs';
import path from 'node:path';
import { openMatrixProfile } from './borrow-matrix-fixture.mjs';

/**
 * The second restart, in a fresh process (the parent already disposed its host). It replays the proof that successfully
 * reclaimed the first boot's claims. A released claim is not an occupation, so both replays must be refused.
 */
const root = process.argv[2];
if (!root) { console.error('usage: borrow-matrix-replay-worker <root>'); process.exit(2); }
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'matrix-receipt.json'), 'utf8'));
const bad = [];
const ownerRef = 'external-owner:' + receipt.callIdentity + ':terminated';
const ioRef = 'external-io:' + receipt.gcEffectId + ':' + receipt.gcFence;
let profile = null;
try {
  const verdict = code => code === 'STOP_NOT_CONFIRMED' || code === 'UNKNOWN_IO' || code === 'CLAIM_IDENTITY_MISSING';
  profile = await openMatrixProfile(root, { sessionId: 'matrix-owner', resume: true, gc: () => new Promise(() => {}),
    gcIntervalMs: 1000000, stream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
    verifyOwnerTerminated: async ({ slot, evidenceRef }) => slot?.callIdentity === receipt.callIdentity &&
      slot?.hostEpoch === receipt.slotHostEpoch && evidenceRef === ownerRef,
    verifyExternalStop: async args => args.effectId === receipt.gcEffectId && args.fence === receipt.gcFence &&
      args.startedAt === receipt.gcStartedAt && args.evidenceRef === ioRef });
  if (profile.runtime.store.read(receipt.slotRef)?.state !== 'released') bad.push('owner claim is not released');
  try { await profile.runtime.ownerControl.reclaim(receipt.slotRef, ownerRef); bad.push('replayed owner proof was accepted'); }
  catch (error) { if (!verdict(error?.code)) bad.push('owner replay refused with ' + error?.code); }
  try { await profile.runtime.runner.reclaim(receipt.gcEffectId, ioRef, { fence: receipt.gcFence }); bad.push('replayed effect proof was accepted'); }
  catch (error) { if (!verdict(error?.code)) bad.push('effect replay refused with ' + error?.code); }
} catch (error) {
  bad.push('second restart failed: ' + (error?.code ?? error?.message ?? error));
} finally {
  try { await profile?.stop(); } catch {}
}
fs.writeFileSync(path.join(root, 'matrix-replay.json'), JSON.stringify({ ok: bad.length === 0, bad }, null, 2));
process.exit(bad.length === 0 ? 0 : 1);
