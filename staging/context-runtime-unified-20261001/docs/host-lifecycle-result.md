# Native Host Lifecycle Writer Result

TASK_TERMINAL: completed (implementation work package only; integrated W2 acceptance remains with root).

Stage: `D:/dsh-test/staging/context-runtime-unified-20261001`.
All four `*-v15` package directories are new physical copies, not junctions. Production and original stage junctions were read only. Existing physical stage `dsh-tools/lib/index.js` is the sole pre-existing edited file. No manifests, preparation scripts, Session, AgentLoop, CP, team runtime, provider, RPC or running services were changed.

## Integration API

Canonical `@deepseek-ai/cordis` exports `getHostLifecycleGate(ctx)`, `HostLifecycleGate`, and `guardHostMethods`. The gate is stored in a global symbol-keyed WeakMap by `ctx.root`; replacing a plugin or reimporting the gate module retains its owner, instance token and monotonic epochs. A different root has a different instance token.

`const gate = getHostLifecycleGate(ctx)` obtains the owner. `gate.acquireRead(requiredDomains)` synchronously returns `{ snapshot, assert(), release() }`, or rejects pending, vetoed, closed or missing-domain states. `acquireTransition()` has identical exclusion semantics. Multiple read leases coexist; async writers wait for all leases, while synchronous mutators throw `HOST_WRITER_BUSY` before their method body. Release is idempotent. A released lease cannot assert.

Root must acquire in exactly this order: **host read lease -> CP fence -> native Session writer**. Keep the host lease through commit/admission, and call `lease.assert()` immediately before authority-changing operations. Release Session/CP ownership before the host lease in `finally`. This package does not acquire CP or Session locks and cannot itself certify that root used the correct order. At next sampling, each retry and tool admission, reacquire/revalidate the real host snapshot alongside the actual active identity and CP/Session epochs. Do not reuse a previous host snapshot after any writer, even if config values returned A -> B -> A.

`snapshot()` returns `{ instance, epoch, pending, veto, domains }`. The instance token is opaque process-local identity, not JSON serialization material. `assert(snapshot, requiredDomains)` checks exact instance + epoch, absence of pending/veto, and requested native participants. Missing domains throw `HOST_DOMAIN_MISSING:<name>`. Domain strings are participant registrations, not a six-domain certificate and not CP/identity/Session proof.

Available native participant names are `cordis`, `loader`, `system-prompt`, `scope`, `scope-parent`, and `tool-registry`; names appear when the corresponding patched runtime paths participate. `cordis` is intrinsic to the gate. An unused/missing participant remains missing, rather than being invented as healthy. The integrated caller must select its required participants; merely calling `participate()` is not evidence of runtime coverage.

`runSync(action, settle?)` preserves the original return shape. `runAsync(action)` waits before invoking the body. `track(task)` independently retains writer ownership through real promise settlement. AsyncLocalStorage and reference-counted writer ownership allow nested awaited installs without acquiring the same writer again. Pending persists through Fiber reload/unload, async promise/iterator setup, registered effect collection, and both synchronous-setup/async-cleanup and async-setup/async-cleanup failures.

`revoke(reason)` immediately sets a first-denial veto and invalidates epochs, even with active leases. Writer/activation failure does not clear it. Only an explicit `clearVeto(gate.snapshot())` after quiescence clears it. `callback(snapshot, action)` rejects epoch-stale callbacks; registered native event callbacks separately retain exact Fiber activation generation and reject `HOST_STALE_CALLBACK` on HMR ABA or disposal. `close()` requires quiescence and permanently rejects subsequent use; there is no replacement owner revival for that root.

## Covered Writers

- Fiber update/restart/epoch transition/reload/unload/effect setup and exact effect disposers; async internal/update return values are tracked even when Fiber.update retains its native void API.
- Registry plugin creation and delete, before runtime map mutation; Fiber.dispose remains pending through actual teardown.
- Loader tree/group create/update/remove/unlink/stop/ensureId; Entry update/refresh/init/_init/_patchContext/_commitVolatile. Options, raw volatile config and live volatile references cannot change inside host leases. Entry.init now awaits actual Fiber settlement, including startup rejection and cleanup.
- SystemPrompt section/context/suppression/tool-provider/variable methods, their owned global/scoped stores and disposers. Deployment/scoped persona registration reaches these methods. Attached NamedEntries.insert/AnonymousEntries.append and their undo functions also participate when invoked directly.
- Attached scope ancestry binds/rebinds. Unattached ancestry can be prepared before any host owns/consumes it; attaching a scope claims its existing ancestor chain. Cross-host ownership conflicts fail before relinking.
- ToolRuntime register/restrict/guard/presentAs and owned stores/disposers. guardReason denies pending/revoked/missing participation. dispatchToolBody rechecks host admission immediately before native generation admission and body invocation; revoke between prepare and dispatch prevents the body.

Borrowed mutable values, arbitrary direct assignments to raw fields or exposed Maps, reflective overwrites of these methods, malicious same-process code, and uncooperative external filesystem writers are outside this controlled-writer boundary. Root must retain the approved environment/threat-model refusal for uncontrolled writers. This does not claim OS isolation, persistent epoch authority, identity activation, two real Team W2 commits, CP durability, or a complete cross-domain certificate. Root's isolated global canonical import mapping and integrated CP/Session/Team validation remain required.

## Deployment Mapping and SHA256

Paths below are relative to stage `app/node_modules/@deepseek-ai/`; deployment paths are canonical package paths under that same root. Package manifests retain canonical names and imports. Deploy the new helper module alongside Cordis index. Never replace original junction targets in place.

| Stage File | deploymentPath | Before SHA256 | After SHA256 |
|---|---|---|---|
| cordis-v15/lib/index.js | cordis/lib/index.js | 6A9394C0877FF45218818C6E815EDD038F8057E1A1DEB390A8D43EC81C57691E | 40AB42055B0F8D00E32C2624F3A64A7CC16174450CBA9C0B540DABF2BB0DDAB9 |
| cordis-v15/lib/host-lifecycle.js | cordis/lib/host-lifecycle.js | absent (new file) | 4A5ADCE2A04AEE718BED3682C22A241510168353631D1F2EA12DBEC0B9547D40 |
| cordis-plugin-loader-v15/lib/index.js | cordis-plugin-loader/lib/index.js | B57C5075E881B4CEB3A15382F506CE549BCBDCD2A0F5BAE292F67E6A83A45B1F | C65B245360589648D5FB00F812EDAB3B35F31DE0C030AD7491149ACA32A8F5B9 |
| dsh-system-prompt-v15/lib/index.js | dsh-system-prompt/lib/index.js | FF422AFAC6BA85F89AFA985D921AED0B603FEB354A05A549C48EAE04CF0D2F57 | 04C38C70B857963B853B38F20A0C43AFB1DEFA8A786C2769E73D1C5A8FE05C20 |
| dsh-scope-v15/lib/index.js | dsh-scope/lib/index.js | 2829DF71D76E08941457D4DD173EAC60783E55354921137C8B75E8B5C0D2ECCA | 0A8E2F4ED7013912002363F450B8825A2A95C5A7E27A66D20755F1B9CB9FCCC4 |
| dsh-tools/lib/index.js | dsh-tools/lib/index.js | 1193D7FFC4FE7D1CDC6F6CB04BD650454917D5BB480FF782AE4CE328AD6DE0E9 | 2FDC9EC60562305ABA7A64C0189CC06DAAA3731E27F55962EFCF161C22BCC9E8 |

`native-tests/host-lifecycle-resolve.mjs` maps only the four canonical package specifiers to physical aliases with Node's `registerHooks`; this mapping also applies transitively to actual package imports. ToolRuntime is imported directly from the existing physical stage package. No production imports were edited.

## Validation and Transcript

Node `v24.17.0`. Command:

```powershell
node --test D:/dsh-test/staging/context-runtime-unified-20261001/native-tests/host-lifecycle.test.mjs
```

Result: **16 tests, 16 passed, 0 failed/cancelled/skipped**. Test-command exit code 0. All six edited/new runtime JS modules separately passed `node --check` with exit code 0. The final successful test transcript is preserved below without unstable timings:

```text
PASS Fiber config and Registry delete reject before fenced side effects
PASS async native plugin remains pending through setup and effect collection
PASS failed async effect stays pending through its async cleanup
PASS Loader config waits before options mutation and actual async setup
PASS nested awaited installation does not wait on its own host writer
PASS global and scoped persona sections and disposers are fenced
PASS owner survives module HMR, epoch rejects ABA and old callbacks, veto survives failure
PASS synchronous effect failure owns asynchronous partial cleanup
PASS native failed plugin remains pending until cleanup, not its method return
PASS real event callback from previous activation cannot revive after A-B-A
PASS real tool registry, scoped restrictions and guard disposal reject before mutation
PASS volatile references retain old values until host transition releases
PASS attached scope parent rebind participates before ancestry mutation
PASS two host readers order a third async installation and rejected setup cleanup
PASS disabling Loader entry stays pending through actual async disposal
PASS native tool body admission rechecks host revoke after preparation
tests 16; pass 16; fail 0; cancelled 0; skipped 0; todo 0
```

Test source SHA256: `FC8DDC93DA7C40747C94F6954AD18C4C4C06A98A3DEBF9FC7AF80BC8E840ECF6`.
Resolver SHA256: `7E8D374C81028AB4BD34191B7E4C3417098DF80DC3391DED3021E06EFA45EB5F`.

No real Team/CP integration run was performed in this work package. No deployment or service restart occurred.
