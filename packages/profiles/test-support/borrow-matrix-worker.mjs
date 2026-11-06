import fs from 'node:fs';
import path from 'node:path';
import { openMatrixProfile, never, until } from './borrow-matrix-fixture.mjs';

/**
 * Crash stand-in: boots the public profile, drives one authenticated owner turn over a transport that never answers and
 * one real gc effect whose port never answers, records what the product durably holds, then exits without stopping.
 * The exit is the restart: nothing in this process is torn down, so no shutdown path can claim the IO stopped.
 */
const root = process.argv[2];
if (!root) { console.error('usage: borrow-matrix-worker <root>'); process.exit(2); }
let profile = null;
try {
  profile = await openMatrixProfile(root, { sessionId: 'matrix-owner', gc: never, gcIntervalMs: 20,
    stream: () => never() });
  await profile.send('hold the owner transport');
  await until(() => profile.runtime.status().capacity.human.current === 1, 'owner H held');
  await until(() => profile.runtime.store.list('effect-io:').some(row => row.effectId.startsWith('gc:') && ['held', 'unknown'].includes(row.state)),
    'gc IO held');
  await until(() => profile.requests() >= 1, 'owner request started');
  const slot = profile.runtime.store.list('control-slot:').find(row => row.holderKind === 'owner-request');
  const io = profile.runtime.store.list('effect-io:').find(row => row.effectId.startsWith('gc:') && ['held', 'unknown'].includes(row.state));
  if (!slot || !io) throw Error('the durable occupation is incomplete');
  fs.writeFileSync(path.join(root, 'matrix-receipt.json'), JSON.stringify({
    teamId: profile.teamId, ownerSessionId: 'matrix-owner', hostEpoch: profile.runtime.host.epoch,
    slotRef: slot.entityId, callIdentity: slot.callIdentity, originRef: slot.originRef,
    slotHostEpoch: slot.hostEpoch, gcEffectId: io.effectId, gcFence: io.fence, gcState: io.state,
    gcStartedAt: io.startedAt, effectTeamId: io.teamId, effectHostEpoch: io.hostEpoch ?? null, effectAttemptId: io.attemptId ?? null,
  }, null, 2));
  process.exit(0);
} catch (error) {
  try { fs.writeFileSync(path.join(root, 'matrix-receipt-error.json'), JSON.stringify({ code: error?.code ?? null, message: String(error?.message ?? error),
    stack: String(error?.stack ?? '').slice(0, 2000) })); } catch {}
  process.exit(1);
}
