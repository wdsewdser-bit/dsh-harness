# PTC Registered Plan Read Dispatch

The current staging PTC plan-read defect is fixed and independently verified.
This is an E1 exact-read delivery repair, not production activation or final
acceptance of the whole integrated natural chain.

## Actual Defect

The official NodePtcRuntime executed team_v12 plan_ref_get under child ID
`official-ptc-plan-ref-root:ptc:1`, while the model-facing tool message used
root ID `official-ptc-plan-ref-root`. The pending map used the child ID only.
Its compact child-value hash also differed from the actual root text with the
official fixed sandbox suffix. The complete registered plan reached the real
offline LlmRuntime adapter, but the durable receipt remained
`read-complete-awaiting-dispatch`, requiredFetch=true, with unresolved debt.

The actual red evidence remains under
`output/e1-ptc-plan-read-20261017/`; no failed record was rewritten as green.

## Scoped Repair

- A candidate records only the trusted nested execution's root identity, not
  an argument supplied by the model. A PTC child result is not model-visible
  delivery.
- The observer accepts only the complete native compact string or native
  two-space object rendering, optionally followed by the exact fixed sandbox
  suffix. Each complete form has its own trusted hash. There is no JSON
  equivalence, substring, plan-ID-only or successful-child-call shortcut.
- Private projected-result identity, branded conversation input, current
  session, non-aborted input/final envelopes, actual handed-to-adapter receipt,
  successful single-text result and exact final body all remain required.
- The runtime still re-reads current task, registered plan, physical source and
  epoch before confirming the durable read. Native direct compact delivery is
  preserved. No PTC engine, global debt policy or permission setting changed.

Frozen sources:

| File | SHA256 |
|---|---|
| home/profiles/web/plugins/team-v12-runtime.mjs | 9b73ea21fd3ee732aebcc55506e1f08c734e86934841a1eb183ee9d26d9266bf |
| home/profiles/web/plugins/team-v15-plan-refs.mjs | abe4504df03e6b4fdeb8d476abd6f31684bb8094f486cc7c3425b93077da9fac |

The only other manual source edit was the corresponding
`phase11-tests/unified-plan-refs.test.mjs`. Headless copies, existing manifests,
the protocol pin and coupling baseline were synchronized by the supported
closeout tools, preserving original before-hash lineage.

## Verification

- Added checks first failed against the old source: 7 tests, 5 pass, 2 fail,
  run `2026-10-17T08-07-48-134Z-5c661b4f`.
- Four focused files then passed 61/61:
  `output/regressions/2026-10-17T08-09-02-937Z-98228319/summary.json`.
- Independent actual PTC review passed 2 positive and 15 negative cases:
  `output/e1-ptc-plan-read-20261017/green/result.json` and `green/review.md`.
  Eighteen local PTC programs and fifteen offline adapter requests used zero
  external provider requests and zero ports. Cleanup completed.
- Negatives preserve debt for arbitrary formatting, reordered fields,
  truncation, extra logs, foreign root/session, auxiliary/unbranded requests,
  prepared-but-uniterated or aborted requests, child-only IDs, failed/multiblock
  results, and stale epoch/source.
- Current complete regression passed: 242 files, 1644 tests, 1643 pass,
  zero fail, one existing skip, real exit0:
  `output/regressions/2026-10-17T08-11-59-037Z-c52e8a91/summary.json`.
- Current Web/API three-stage acceptance and independent 69-event JSONL cold
  reconstruction passed on this synchronized stage. The E1 final record and
  independent registry readback are under
  `output/e1-delivery-closeout-20261017/`.

The current 162-carrier stage inventory hash is
`5fa097a4ab15cc9eb69eb3a4266ebfad0d06a0f93a4a508e9ccf853000fbeb1e`.
All 58 registered plugins agree across four logical profiles and two physical
plugin directories. Production's eight protected files remained unchanged.

## Rollback And Limits

Backup: `backups/e1-ptc-plan-read-20261017/`. Before any restore, verify that
each current target is still the exact repaired version, preserve intervening
user changes, restore only this delta and refresh the recorded profile/pin
bindings. Retain session journals, read receipts and canonical evidence; do not
delete durable records to erase a completed dispatch.

No production files, active Team, global feature default, provider route or
sandbox policy were modified. Static/fixture and current Web acceptance do not
substitute for the separately budgeted integrated natural-chain gate.
