# Focused verification

Executed 2026-10-24 UTC in `D:/dsh-test`:

```
node --check staging/window-auto-longtest-20261024/runtime/window-auto-engine.mjs
node --test staging/window-auto-longtest-20261024/runtime/window-auto-engine.test.mjs
```

Syntax check exited 0. Focused tests: 40 passed, 0 failed, 0 skipped.
No network requests or paid/provider calls were made by these checks.

Coverage includes positive W2 callback dispatch and W1 synchronous request
selection; unknown price/usage/cost/quality/horizon; route, actor, candidate and
source mismatches; busy/effects boundaries; evidence and certificate expiry;
raw-cap preservation; duplicate suppression; concurrent tick coalescing;
asynchronous stale-source/boundary guard; disposal; executor/audit failure;
malformed candidates; and a real canonical W1 planner/authority positive path
plus canonical native CAS refusal after W3 approval.

Self-review corrected two issues before completion: W1 must use the real running
request boundary rather than pretending idle; duplicate candidate IDs are refused
so the selected economics and bound native candidate cannot become ambiguous.

Limits: synthetic economics fixtures are not real prices or provider usage. W2
callback tests do not prove real native durable commit or provider acceptance;
the longtest driver must integrate native `tryFold` and record its real receipts.
W1 native tests prove planner/dispatch validation, not provider handoff. The host
is responsible for verifying certificates and evidence, calling the guard at the
actual side-effect boundary, retaining native gates, and constructing one engine
per host lifetime. Engine serialization is local to that engine instance; native
W2 services retain their own process/session gates. No production deployment or
claim of real fee savings is included.

Additional durable-boundary verification, 2026-10-24 UTC:

```
node --test staging/window-auto-longtest-20261024/runtime/window-economic-commit-guard.test.mjs
```

9/9 passed using real canonical Session, native bridge, native JSONL persistence
barrier and canonical createWindowTransition. Positive commit persists exactly
one window commit despite maintenance-only epoch changes. Async source changes
at before-prepare and before-commit refuse append. Signal, disposal, policy, raw
safety and candidate changes queued in a microtask after the final async fault
hook all refuse append; disk/live journals contain zero window commits and
canonical recovery produces ABORTED. Unarmed native capacity folds still work.

These tests exercise real transaction/persistence boundaries, not the complete
native collector + installed surface. The root driver must integrate writer-safe
collector/raw readers, stable effective policy binding, helper lifecycle, and the
native recovery path before claiming automatic W2 longtest acceptance.
