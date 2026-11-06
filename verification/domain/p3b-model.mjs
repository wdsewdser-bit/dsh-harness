import assert from 'node:assert/strict';
import { hostScenario } from '../integration/p3b-host.mjs';
import { p3Core } from './p3-tests.mjs';

/** Record scripted native transport and peer protocol metrics without model claims; 08 §7.3. */
export async function modelContracts(root, scenario, provider) {
  assert.equal(scenario, 'cross-peer-dependency');
  const native = await hostScenario(root + '/native', provider);
  const protocol = await p3Core(root + '/protocol');
  return { native, scenario, provider: 'scripted', protocol,
    metrics: { ...native.metrics, coordinatorPeerMessages: protocol.coordinatorPeerMessages, protocolLatency: protocol.rawLatencyMs },
    limitations: ['Root context growth is request JSON characters, not tokens or costs.',
      'Decision latency measures scripted core review, not model reasoning; coordinator peer is a protocol fixture.'],
    modelCommunicationValidated: false };
}
