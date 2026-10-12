import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PiAiAdapter } from '../app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
import { windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function createProtocolTrialEvidence(binding, sessionId, now = Date.now(), { nativeSurface = false } = {}) {
  if (!binding?.sdkSha256 || binding.schemaCount !== 75 || typeof sessionId !== 'string') fail('LAB_PROTOCOL_BINDING_REQUIRED')
  const paths = {
    projection: ['../home/profiles/web/plugins/team-v15-window-projection.mjs', '1fa23c04cc6fbb9ae6c0d36234f571bf34cc4a3a421d087971a364aca458bb64'],
    requestProjection: ['../home/profiles/web/plugins/request-message-projection.mjs', '7ecf041e6aa4248eae78b8c979aaa679dd01f58f1e3f67ae5812527a4db8013a'],
    protocol: ['../home/profiles/web/plugins/team-v15-window-protocol.mjs', 'a1bfafabede1e2df38e3fd67f0ad688ef1ac3be2799c951d348ac0b461d57939'],
    collector: ['../home/profiles/web/plugins/team-v15-window-collector.mjs', 'f175b9f7a5980f33851cae4879a041f9501db3d6efdded84b83d89224685a1cc'],
    historyRecall: ['../home/profiles/web/plugins/team-v15-history-recall.mjs', '9d3fe6985e88b66c29148a448b5850cb34c3ca9b7b4906baa22048a6a29e9463'],
    usageLedger: ['../home/profiles/web/plugins/request-usage-ledger.mjs', 'f19d86fa4cfc45b6f650480b01de5819bf9b56674c5033e63a3ef02755b63680'],
    windowEconomicsRuntime: ['../home/profiles/web/plugins/team-v15-window-economics-runtime.mjs', '18a0cb95f47682ef9f48eeffcf5a2eb15cc39c2c0f78bff7c2982e4f8c287c86'],
  }
  const modules = {}
  for (const [name, [path, expected]] of Object.entries(paths)) {
    const current = sha(readFileSync(new URL(path, import.meta.url)))
    if (current !== expected) fail('LAB_PROTOCOL_SOURCE_DRIFT')
    modules[name] = current
  }
  const testLog = readFileSync('D:/dsh-test/output/context-runtime-window-reasoning-proof-final-20261003.log')
  if (sha(testLog) !== '949478bab562ed79c7540256920f37b0a3afa6fbc70c3e76d7b8ef46be62bdcb') fail('LAB_PROTOCOL_TEST_EVIDENCE_DRIFT')
  const bindingLog = readFileSync('D:/dsh-test/output/context-runtime-window-request-binding-final-20261003.log')
  if (sha(bindingLog) !== '2260186ab3edbd74cf8cb70bf72429226b8c95b3a73ef208c0d134bd20d8ef12') fail('LAB_PROTOCOL_BINDING_TEST_EVIDENCE_DRIFT')
  const assemblyLog = readFileSync('D:/dsh-test/output/context-runtime-history-assembly-integration-final-20261003.log')
  if (sha(assemblyLog) !== '364f2494d68f138e988d3e2d492a7ee27e835dc831b9b5c49e9ac6bc15fe460f') fail('LAB_HISTORY_ASSEMBLY_TEST_EVIDENCE_DRIFT')
  const recoveryLog = readFileSync('D:/dsh-test/output/context-runtime-instant-idempotence-focused-r2-20261004.log')
  if (sha(recoveryLog) !== '7005fe143df473717f6e2e2cbcce8b5ffe45296808ecef4d683c29b4b81a5cca') fail('LAB_NATIVE_RECOVERY_TEST_EVIDENCE_DRIFT')
  const instantLog = readFileSync('D:/dsh-test/output/context-runtime-instant-ui-focused-final-20261004.log')
  if (sha(instantLog) !== '98fdf9fc08d454aa8726dbf5d3001df72ce5e08644572f776627000588d09cad') fail('LAB_INSTANT_API_TEST_EVIDENCE_DRIFT')
  const usageLog = readFileSync('D:/dsh-test/output/context-runtime-usage-preempt-focused-r1-20261004.log')
  if (sha(usageLog) !== '702ad847278fdbae3e51935d52cdb25e844b2b6d0b2ddd7ce109be98fcea8a98') fail('LAB_USAGE_PREEMPT_TEST_EVIDENCE_DRIFT')
  const agentLifecycleLog = readFileSync('D:/dsh-test/output/context-runtime-agent-lifecycle-focused-r1-20261004.log')
  if (sha(agentLifecycleLog) !== 'f9b8657d9bd08381d430ce5ac8f4f40cf2f504373562d7d3f9d87c03f50e1a6c') fail('LAB_AGENT_LIFECYCLE_TEST_EVIDENCE_DRIFT')
  const quietClaimLog = readFileSync('D:/dsh-test/output/context-runtime-quiet-claim-integration-r1-20261004.log')
  if (sha(quietClaimLog) !== '1968aa10b92d3d39d7eebd9d9edead852e4ffcccbed5df7afb63b8691fda2d01') fail('LAB_QUIET_CLAIM_TEST_EVIDENCE_DRIFT')
  const subagentDurableLog = readFileSync('D:/dsh-test/output/context-runtime-subagent-durable-focused-r4-20261004.log')
  if (sha(subagentDurableLog) !== '71d49f50132adb67b7aad1899f2e53753af7424c6516da39e7f51e2deaea7a3b') fail('LAB_SUBAGENT_DURABLE_TEST_EVIDENCE_DRIFT')
  const goalDurableLog = readFileSync('D:/dsh-test/output/context-runtime-goal-durable-final-r1-20261005.log')
  if (sha(goalDurableLog) !== '083d427e8cb7fe717d5dd07ed2c2225a9f45bd10cdb11a472c5c13bff05fafa7') fail('LAB_GOAL_DURABLE_TEST_EVIDENCE_DRIFT')
  const deliveryCloseoutLog = readFileSync('D:/dsh-test/output/context-runtime-claude-closeout-focused-20261006.log')
  if (sha(deliveryCloseoutLog) !== '579b9cd55b6892b604b1a2de53fb8e4014a6ff5e83b4d0ed39d4bf7ccbc87e07') fail('LAB_DELIVERY_CLOSEOUT_TEST_EVIDENCE_DRIFT')
  if(nativeSurface)for(const [name,path,expected] of [
    ['nativeSurface','../home/profiles/web/plugins/team-v15-window-surface.mjs','4a158947032e9b88aea6cdb6582cfa4f757427ee65b13ea5a119af641995cde8'],
    ['fileProtection','../home/profiles/web/plugins/team-v15-window-file-protection.mjs','4db63d07bf3720b1898075cc9c0f841fc4c5b37bb2de5743f74e37dc9984f97a'],
    ['transition','../home/profiles/web/plugins/team-v15-window-transition.mjs','765918ee52854d2ff3a32b2fa1743099600f5b61022e42b19b33eacec5390135'],
    ['participation','../home/profiles/web/plugins/team-v15-window-participation.mjs','3113ac5a8a3a2443aa148a120dcec57eef4e264b2a0c801cf9e9e8e79e519f86'],
    ['control','../home/profiles/web/plugins/team-control-plane.mjs','105b00d39f756abc7691948082bb1dc5a823cbaa1bb8660cf72207622a834f43'],
    ['teamRuntime','../home/profiles/web/plugins/team-v12-runtime.mjs','0b0b3e5c6baf26c8f9c6ea6f23b055210a020e102238bd7822e8bf1fe3a9a2bd'],
    ['goalDelivery','../home/profiles/web/plugins/team-v15-goal-delivery.mjs','49dc27d5900e222b5c7de8c7305f579814fb0781b320e9a95f4ef07d9db0c7fb'],
    ['goalDomain','../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js','6bb5985f65c987193c4dda95d4a0b4e3b84b082f3ca0087a135a6b575140c104'],
    ['nativeSession','../app/node_modules/@deepseek-ai/dsh-session/lib/index.js','e6b9e61986c73286b4b35167214bbb3218202bf92e26fcc7b89ce19d876ff8a8'],
    ['nativeBridge','../app/node_modules/@deepseek-ai/dsh-session/lib/native-bridge.js','87122a1536428079812a2d56b34333160dd19ae32ba2210be86ff762d47924fe'],
    ['agentLifecycle','../app/node_modules/@deepseek-ai/dsh-agent-v15/lib/index.js','957ae90d11c99b68e42508b737222c94f958d16c4b53f04fbbfd7aab6e8f512e'],
    ['instantDriver','../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js','b55034743be0f046db5de6456c21a72b85d35ae6721492fc39681825c841e056'],
    ['subagentDurable','../app/node_modules/@deepseek-ai/dsh-subagent-v15/lib/index.js','566accb62b480beb54930bdab0ede88231e64424c1588c3eb01f23497bbe3b2e'],
    ['instantApi','../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js','ebf99f58c2bde6620cb4412ad5ea516d0f93751a7dbf2659e1d31748b3d92954'],
    ['instantClient','../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js','da5ae37ba208bb70104ad891c3ca6c6062bed37afc7e7d9eeb47ae90ffa41b71'],
    ['instantUi','../app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js','b8185386194422f55e7c1b1bb1f7637dfdad916e219460ed5655ac32e1448ffa'],
    ['instantHostCodec','../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js','170d12f104796da8dd288ee15e2f9a104e130a38fafdd8d853284c48263f8eb5'],
    ['instantRemoteCodec','../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js','817df1e6e484c78eddc8bafde358b38985c06deb78ed5f827120d2fbeb553c51'],
    ['liveBarrier','../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js','91efc8a9953e36c664e509d08a0852f43f08b16d97581f5e6102f23dbbeaf76f'],
    ['jsonlBackend','../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js','18070a88a63600ee7fbc922400a1ab0fdadec07fa27542e678045fb970fca9f6'],
  ]) {
    const current=sha(readFileSync(new URL(path,import.meta.url)))
    if(current!==expected)fail('LAB_NATIVE_SURFACE_SOURCE_DRIFT')
    modules[name]=current
  }
  const adapterHash = sha(readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js', import.meta.url)))
  const converterHash = sha(readFileSync(new URL('../app/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js', import.meta.url)))
  const body = { kind: 'isolated-protocol-trial-v1', providerAccepted: false, productionAuthorized: false,
    sessionId, route: { provider: 'opencodego', model: 'deepseek-v4.1-flash', api: 'openai-responses' },
    sdkSha256: binding.sdkSha256, schemaCount: binding.schemaCount, modules, adapterHash, converterHash,
    testLogSha256: sha(testLog), bindingLogSha256:sha(bindingLog), assemblyLogSha256:sha(assemblyLog), recoveryLogSha256:sha(recoveryLog), instantLogSha256:sha(instantLog), usageLogSha256:sha(usageLog), agentLifecycleLogSha256:sha(agentLifecycleLog), quietClaimLogSha256:sha(quietClaimLog), subagentDurableLogSha256:sha(subagentDurableLog), goalDurableLogSha256:sha(goalDurableLog), deliveryCloseoutLogSha256:sha(deliveryCloseoutLog), nativeSurface,
    projectionOrder: 5, collectorOrder: 4, reasoningPolicy: 'whole-completed-turn-v1',
    expiresAt: now + (nativeSurface ? 120000 : 90000) }
  return Object.freeze({ ...body, certificateHash: windowHash(body) })
}

export function installReplayTrialGuard(adapter, record = () => {}) {
  if (!(adapter instanceof PiAiAdapter) || typeof adapter.config?.resolveApiKey !== 'function') fail('LAB_ACTUAL_PI_ADAPTER_REQUIRED')
  const descriptor = Object.getOwnPropertyDescriptor(adapter, 'config')
  if (!descriptor?.configurable) fail('LAB_PI_CONFIG_IMMUTABLE')
  const original = adapter.config
  const guarded = { ...original, onReplayDegrade() {
    record({ event: 'protocol-replay-degraded', code: 'LAB_REPLAY_DEGRADE_REFUSED' })
    fail('LAB_REPLAY_DEGRADE_REFUSED')
  } }
  Object.defineProperty(adapter, 'config', { ...descriptor, value: guarded })
  return () => { if (adapter.config === guarded) Object.defineProperty(adapter, 'config', descriptor) }
}
