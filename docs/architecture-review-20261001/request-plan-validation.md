# Batch A request plan validation

Date: 2026-10-01 (Asia/Shanghai)
Status: staging implementation and focused validation complete; deployment pending root acceptance.

## Scope and boundary

Staging plugin root:
`D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/`

Changed plugins: `request-message-projection.mjs`, `ptc-sdk-retention.mjs`,
`observation-pack-v2.mjs`, `request-usage-ledger.mjs`, `step-compaction-v4.mjs`,
`team-v13-cache-monitor.mjs`.

No installed app or live profile code was edited. No provider model request,
service restart, active Team action, full regression, or live HMR was performed.
Native dispatch validation uses in-process fixture adapters on real Cordis and
real LlmRuntime copies. A fixture adapter handoff is not proof of provider receipt
or of a model reading the full observation.

## Request API

The legacy signature remains supported:

```js
service.register(id, transform, { order: 30 })
```

The extension is explicit:

```js
service.register(id, transform, {
  order: 30,
  preview: pureTransform,
  onDispatch({ options, inputOptions, result, receipt }) {},
})
const preview = service.preview(canonicalOptions) // { options, receipt }
const plan = service.prepare(canonicalOptions)  // { options, receipt }
preparedCall.stream(plan.options)              // adopts this plan once
service.audit(options, requestId)              // latest immutable receipt
const readReceipt = service.capture(options)   // reader bound to this attempt
service.isAgentLoopRequest(canonicalOptions)   // bound official module WeakSet
```

Preview invokes only an explicitly registered `preview` function. A legacy
transform is `skipped-no-pure-preview`. Preview does not publish a request, call
prepareCall, dispatch an adapter, increment OP fullSends, or persist SDK audits.
`prepare` executes the final transforms once and locks a detached immutable
messages/tools/toolHistory snapshot plus outer options, including identity
projections. Original caller objects remain mutable; later caller edits cannot
change the prepared payload. Passing the returned options to the native stream
adopts that exact snapshot. `receipt.preparedSnapshot` is true for a locked plan.
When unknown protocol values cannot be safely snapshotted, prepare returns the
original options with `unprepared-fail-open` and `preparedSnapshot: false`; it
does not register that mutable request as an adoptable prepared plan. Native
dispatch then builds a new attempt from the current caller input. The native prepared config and
registration are retained, including generation A after route replacement by B.

`onDispatch` runs in native `adapterStream` at `forAdapter`, after native file,
image and tool projection and immediately before native adapter dispatch. A
blocked waterfall, uniterated stream, failed preparation, or signal aborted
before that boundary does not publish a handoff or consume OP fullSends.

Receipts have attempted/handed-to-adapter stages, requestId, session/provider/
model/purpose, optional turn/task/workflow IDs, before/after message JSON bytes
and SHA256, first changed message index, common-prefix bytes, prepared config
fingerprint, safe transform metadata fingerprints and native adapter payload
fingerprint. Receipt metadata contains no message body or function. Provider
receipt stays unknown unless separately supplied by the real stream; adapter
usage and provider request IDs remain in the usage ledger with their own source.

The ledger captures a receipt reader at request entry, so simultaneous requests
sharing one unchanged options object remain distinct even after bounded audit
history eviction. A prepared projection does not change signal, tools,
toolHistory, call configuration, request brand or caller context. Transform
inputs have detached immutable messages/tools/toolHistory. Unknown values or
protocol shapes fail open.

The public `isAgentLoopRequest` guard calls the official LLM module bound to this
runtime. It does not infer canonical status from sessionId. An unbranded request
or a request branded by the other app/profile module is false; canonical prepared
requests and their bridge-created preview/final clones retain the correct brand.

## SDK and OP policy

SDK auxiliary requests retain history by default. Explicit compaction enablement:

```js
{
  mode: 'apply',
  policy: 'latest',
  purposePolicy: {
    conversation: 'ptc-only',
    compaction: 'certified-latest',
  },
  compatibilityManifestPath:
    'D:/dsh-test/docs/context-opt-20261001/sdk-compatibility-manifest.json',
}
```

Compaction may have no live tools list, so its purpose-specific strategy checks
the existing five-version compatibility certificate directly. Missing/unknown/
reordered versions, incompatible rendering, uncertified latest or other
auxiliary purposes retain the original SDK. The certificate was not weakened.
The default compaction purpose policy is `retain`.

OP runtime projection is pure (`projectMessages(..., { consume: false })`). The
first two actual full-text native handoffs retain the original result; the third
gets the verified handle. Only exact full-text hash matches in the final native
payload consume the full-send counter, once per observation per request. Error,
mixed/unknown content and missing/corrupt/symlink archives retain original data.
The handle keeps original L2/L173/L399 citations. Preview reads the verified
cached handle without mutation; cache maintenance occurs at dispatch. The direct
helper retains its legacy `consume: true` default for old callers; the runtime
bridge always supplies `consume: false`.

## Meter and cache attribution

Raw native session pressure remains the safety authority. `preStepBudget` still
rejects when raw tokens plus output reservation and safety margin exceed the
window. The new economic observations are parallel diagnostic fields:
`rawSafetyTokens`, `rawRequestBytes`, `projectedRequestBytes` and a content
estimate explicitly marked as neither tokenizer counts nor wire bytes. They
cannot relax rejection. Native unknown image pricing and unknown route/tokenizer
pricing retain conservative handling. Session-revision meter caching is reused.

Cache monitoring first reads bounded session-specific terminal ledger records
(up to 16 files, one MiB tail per file, 256 requests). Attribution requires the
same requestId, same sessionId and a real handed-to-adapter receipt. Future
handoff timestamps are rejected. An unchanged receipt is still observable;
unrelated session events and future mechanism telemetry are never selected as
causes. A journal row lacking an exact request receipt is attribution unknown.
Cache ratio comparison requires all three input components to be known.
Even an exact receipt does not prove the projection caused a cache drop.

## Validation

Node: v24.17.0. Syntax checks passed on all six changed plugins.

```powershell
$env:DSH_REQUEST_STAGING = '1'
$env:DSH_REQUEST_PLUGIN_ROOT = 'D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins'
node --import ./architecture-tests/request-staging-loader.mjs --test `
  ./architecture-tests/request-plan.test.mjs `
  ./usage-tests/request-message-projection.test.mjs `
  ./usage-tests/ptc-sdk-retention.test.mjs `
  ./usage-tests/request-usage-ledger.test.mjs `
  ./usage-tests/observation-pack-lineage.test.mjs `
  ./phase10-tests/observation-pack-v2.test.mjs `
  ./phase11-tests/v14-cache-monitor-lru.test.mjs
```

Result: 64 tests, 64 passed, 0 failed, 0 skipped; no external provider calls.
Subsequent brand-guard increment: `node --test --test-name-pattern 'public brand guard'
./architecture-tests/request-plan.test.mjs` passed 1/1 with app and profile cases;
the bridge syntax check also passed. The preceding 64-test suite was not rerun for
this additive read-only method. After the reviewer identified mutable identity
prepare drift, `node --test ./architecture-tests/request-plan.test.mjs` passed
11/11. Two added counterexamples verify that prepared content stays fixed after
caller message/tool/history edits (after hash equals native adapter payload hash),
and that unknown protocol data remains native unprepared fail-open with a fresh
attempt receipt. The bridge syntax check passed again. No provider model was called.

After native HMR review, staging OP teardown now registers one idempotent disposer
through both Cordis `ctx.effect` and the legacy fixture `dispose` event. The real
Cordis regression runs plugin `fiber.restart()` twice and `fiber.dispose()` twice;
registration count is `1 -> 1 -> 1 -> 0`, with no duplicate-ID error. The focused
staging command combining `request-plan`, OP lineage and phase10 OP suites passed
**27/27** (12 request-plan, 8 phase10 OP, 7 lineage OP), 0 failed, 0 skipped.
This is a fixture-adapter/Cordis lifecycle check; it does not reload the live HMR
service or call a provider.
The loader redirects plugin code only. It does not use the broad resolver that
can collapse installed app/profile LLM modules into one copy. Tests explicitly
assert distinct constructors and separate brand WeakSets.

New tests cover pure preview, legacy compatibility, prepared one-time adoption,
bytes/hash/prefix receipt, pre-dispatch abort, middleware block, uniterated return,
OP delayed full handoff counts, independent module brand and caller context,
prepared A/B generation, unknown/image shapes, tool/history mutation protection,
raw safety rejection, concurrent unchanged requests plus audit eviction, exact
ledger identity, unknown usage, cross-session/future cache events, and certified
compaction SDK projection through the real native adapter.

Two existing OP test harnesses were updated to invoke `onDispatch` explicitly,
preserving their full/full/handle, citation, mixed/error and corruption assertions.
Staging runs put their runtime evidence in temporary directories rather than
overwriting the prior live fixture evidence. Harness originals are backed up in:
`D:/dsh-backups/architecture-clm-20261001-071217/request-test-harness/`.

## Plugin SHA256

| File | SHA256 |
| --- | --- |
| request-message-projection.mjs | FB0CBD2B30432921764DD8DFC3AB535C02B5DF2A47EB784302E2E9AD2511520C |
| ptc-sdk-retention.mjs | 41846B9F499BB6B7A170BDF135412E49E7AF3B65350458798E0B64EE4DA285C9 |
| observation-pack-v2.mjs | 874B1F1C31371A782620D856EF560D5CD7365F4B0CED592FCE60A74E1096FAEF |
| request-usage-ledger.mjs | 5AE0B570476CFDE4430B6C6E5720357FF3E413F89A1371F6FA31E7F49F6CB58A |
| step-compaction-v4.mjs | 1939379DD0C23528E4DC35FF2270EFAA99D5DB67686F54752132146506012335 |
| team-v13-cache-monitor.mjs | 5634AE5AC8F149AB1A5F30B6CB1043E360609521AB8340DE517958098718C0D4 |

Remaining acceptance: root review, four-profile parity/deployment and authorized
live consuming-surface verification. No cash savings or provider-read guarantee
is asserted. Installed runtime changes to the native boundary require a fresh
compatibility check; unknown message/tool values retain the original request.
