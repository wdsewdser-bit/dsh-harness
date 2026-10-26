# Isolated W3 automatic window engine

`window-auto-engine.mjs` is a standalone host-side engine with no dependencies beyond Node.
It does not modify accepted W1/W2 modules or production configuration. `mode: auto`
means a real enabled dispatcher exists; every execution still needs evidence. It is
valid and expected for an enabled run with incomplete evidence to defer every time.

## Integration

Construct `createWindowAutoEngine({ enabled: true, adapter, audit, clock })` once in
the isolated host. `audit(row)` must synchronously persist the row (or throw).
Adapter functions are captured at construction and must come from trusted host
code; do not expose this constructor, evidence, executors or guards as model tools.
`evidence-example.mjs` supplies the exact evidence shape with unknowns preserved.
Route requires `provider`, `model`, `protocol`, `priceVersion`. Hashes are SHA256 hex.
The host verifies certificates and native preview/authority before asserting
`certification.verified`. The certificate binds the actual candidate, source,
session, actor and route. Never certify an unrelated historical candidate.

`adapter.readEvidence(sessionId)` is synchronous, returns a fresh cloned snapshot,
and observes the actual native session/actor, source/revision, route, raw admission
measurements, live phase/effects, candidate preview and economics. Unknown usage
fields remain null, including cache writes and reasoning. All five token components
must be known before dispatch. Quality has a verified evidence reference; horizon
has estimate, uncertainty and source. Each cost has amount, unit and source.
`pricing.known` means explicit configured pricing evidence is present, not that an
invoice is known. Relative estimates must use unit `relative-cost` and kind
`relative-estimate`; outputs always say `estimated: true`, `realFeeClaim: false`.
No price coefficients are supplied by this package.

### W2: idle maintenance

Call `await engine.tick(agent.session.id)` on actual idle boundaries.
`adapter.executeW2({ sessionId, actorId, route, sourceHash, revision, candidate,
guard, signal })` is a preconfigured host callback. Resolve the real native agent,
read actual fold facts, call `guard()` immediately before invoking
`windowExecutor.tryFold(agent, facts)` or the existing wiring service's equivalent.
Do not use manual mode, fake a milestone, lower raw gates or waive native policy.
Map native `outcome === 'folded'` to `{ applied: true, receiptId }`; native refusal
maps to `{ applied: false, reason }`. An economic approval may still be refused by
the native threshold policy, and that is recorded as `native-refused`.
If callback awaits before invocation, check signal and call guard after that await.
Native commit must retain its existing authority/CAS/live-barrier checks after any
internal await. Economics never authorizes hard-safety compaction; the raw native
compaction path remains installed and independent.

### W1: synchronous certified request boundary

W1 is not selected at idle: call `engine.dispatchW1(sessionId)` synchronously from
the host's native request transform after obtaining the real certified preview.
The evidence must report `live.certifiedRequestBoundary: true`,
`adapterValidation: true`, actual request ID and zero effects in flight. Actual
`idle` may be false; do not fake it. `adapter.executeW1(args)` must be synchronous,
call `args.guard()` immediately before choosing/returning the preview into the
native transform, and keep native `validateAdapter` / `validateDispatch` checks.
The host retains the preview in its request-local closure; the engine receives its
bound candidate hash, never arbitrary model payloads. Return `{ applied: true,
receiptId }` only when the native transform selected it. This outcome is selection
at the transform, not proof of provider handoff or billing: native dispatch and
terminal receipts are still required for those claims. No guard waives native
checks. Failed economics returns original messages through host fallback.

Per-session W1 dispatch and W2 ticks cannot overlap. W2 ticks coalesce in flight;
attempts deduplicate by source/actor/route/candidate, W1 additionally by request ID.
Failures/refusals are remembered without retry storms; a new source/candidate (or
new W1 request) is needed for a new attempt. Bounded capacity refuses rather than
evicting dedup state. `dispose()` aborts pending actions and awaits callbacks;
callbacks must honor the signal and guard to prevent late side effects. An action
already synchronously started cannot be undone; its receipt remains auditable.

Run focused checks: `node --test runtime/window-auto-engine.test.mjs` from the
longtest directory. Test prices, usage and quality are synthetic fixtures only.

## W2 Durable Boundary Guard (Required For Economic W2)

An economic guard before `tryFold` is insufficient: native installation, plan
publication, retention, maintenance and participation can await before durable
append. Likewise `fault('before-commit')` is awaited and is not the final atomic
authorization boundary. Install the additive host-only boundary helper from
`window-economic-commit-guard.mjs` once per installed session:

```js
const gate = installEconomicCommitGuard({
  session: agent.session,
  readSource: ({ writerToken } = {}) => state.collector.authorityForSurface(
    agent.id, writerToken ? { writerToken } : {}
  ).capture(agent.id).source,
  readPolicyBinding: () => ({
    agentOptions: agent.options,
    certificateHash: state.handle.certificateHash,
    config: effectiveStableHostPolicy,
  }),
  readRawSafety: ({ writerToken, source }) => readTrustedWriterSafeRawSafety(writerToken, source),
  audit,
})

// Inside trusted executeW2; the same guard and signal came from the auto engine.
const result = await gate.run({
  guard, signal, actorId, candidateHash: candidate.candidateHash,
  sourceEventSeqs: state.idleFrame.preview.checkpoint.sourceRange,
  expiresAt: state.idleFrame.expiresAt,
}, () => executor.tryFold(state.agent, facts))
```

Call `gate.dispose()` before/with engine disposal and before replacing a session
install. Native capacity-policy folds performed outside `gate.run` remain
independent. The host must never invoke economic W2 through an unguarded path.

The helper synchronously wraps the actual session's dynamic `append` method and
checks immediately before its `user/message` / `source.windowCommit` append.
The same call stack performs signal/disposal/expiry checks, writer-safe source
capture, stable policy/config comparison, raw safety and exact selected event
sequence comparison, synchronous audit, a second check, then original native
append. It introduces no await, alters no native gate, and changes no source
certificate module. Only one permit is active; replacement of the wrapper is
refused when arming. Callbacks and method installation are trusted host code.

Semantic binding preserves every collected source field except `events`, the
non-authoritative `working`, and `configFingerprint`; it also omits only `host`
and `nativeBoundaryHash` from the critical revision vector. These omitted hashes
change as a consequence of native maintenance and the transaction's own intent.
Everything else, including authority/inbox, messages, spans, recovery, plan,
identity, source revisions and remaining vector fields, must remain identical.
Independent effective policy/config binding is mandatory because the collected
`configFingerprint` includes the transient host epoch. Do not pass an empty or
irrelevant policy object. If plan publication or retention changes meaningful
source, the guard refuses; it never normalizes that change away.

Raw safety must be measured through a real writer-safe reader at this boundary.
Ordinary token-meter APIs may refuse while the native writer fence is held.
A host may reuse a real measured raw result only when it explicitly binds that
measurement to the identical semantic source and effective policy; it must label
that provenance and must not turn missing measurements into zero. Otherwise
refuse economic W2. Native raw safety and capacity policy stay independent.

Refusal at append leaves a durable PREPARED intent fenced until the existing
native recovery path aborts it. Recovery must run before further requests; do
not clear the fence or claim a fold succeeded. The root driver must test real
collector/maintenance integration in addition to the canonical transaction tests.
