# Usage Audit Validation

## Focused Checks

- `node --check tools/usage-history-backfill.mjs`: passed.
- `node --test usage-tests/usage-history-backfill.test.mjs`: 12/12 passed.
- `node --check home/profiles/web/plugins/request-usage-ledger.mjs`: passed.
- `node --test usage-tests/request-usage-ledger.test.mjs`: 17/17 passed.
- `node --check tools/usage-audit-snapshot.mjs`: passed.
- `node --check tools/usage-lab.mjs`: passed.
- `node --test usage-tests/usage-lab.test.mjs`: 10/10 passed.
- Combined new-module focused run: 39/39 passed; log `focused-tests.txt`.
- Both historical-review findings and both observer-review findings were corrected,
  then independently rechecked with verdict accept. Review did not call the provider.

## Profile And Runtime

- All four logical profiles mount exactly one `request-usage-ledger` entry.
- Module SHA256 is `C8BFEB5C020C57D162799E4350980644752D1DF7EE5BC8B287EA3B6801FCB087`.
- Structured comparison against the original profile backups, after removing only
  the new mount, is identical. Existing `!!js` expressions are parsed as tagged
  scalar text for comparison; they are not evaluated or reserialized.
- `desktop` is an existing directory junction to `web`; `teamtest/plugins` is an
  existing junction to `web/plugins`. These links were preserved, not replaced.
  Therefore desktop intentionally shares the web observer label.
- Original backups: `D:/dsh-backups/usage-ledger-20261001`.
- HMR loaded the matching module into PID 16440 at `2026-09-30T19:39:20.892Z`.
- PID 16440 creation time remained `2026-09-30T16:37:18.148579+08:00`.
- Two continuing RustMc root requests produced real terminal usage, with totals
  702,773 and 702,950. This is evidence that existing sessions need no restart.
- An isolated DSH session `session-58d081fd-d2c0-46b7-b810-6c8f14289eeb` produced
  a real terminal receipt of 52,796 total, 51,315 uncached input, 1,408 cacheRead,
  and 73 output. The prompt requested no tools and one fixed reply.
- Missing adapter fields such as cacheWrite/reasoning remain null. The observer
  cannot invent raw wire fields not exposed by the canonical DSH usage adapter.
- Current live Reducer: enabled=true, routeMode=session, remoteAllowed=false,
  localProviders=[]; the audit did not change these settings. The opencodego
  route remains excluded. Isolated Reducer calls do not enable the production hook.

See `live-verification.json` for measured metadata, canonical usage and parity.

## Full Regression

The 132 phase1 through phase11 test files were run with the existing runtime
resolver and concurrency 1, using an isolated `DSH_HOME` to avoid mutating active
control-plane data. Full log: `regression.txt`.

The same full set was also rerun after the observer mount was installed; log
`regression-after-deploy.txt`. The later log is the delivery-time regression
evidence, while the original log preserves the pre-mount baseline.

Node reported 561 tests: 558 passed, 2 failed, 1 skipped. This is not a green full
regression. There are also three self-reported FAIL lines in the health script
which does not propagate them as a failing exit code.

- B-96 external evidence checkout: the full run's isolated DSH_HOME changed the
  checkout-root expectation. A focused rerun with the real DSH_HOME and only
  `--test-name-pattern 'B-96:'` passed 1/1. No platform source was changed.
- `phase3-tests/team-tools-v2.test.mjs`: its standing GROUP LEAD identity text
  assertion still fails against the current prompt. Focused rerun reproduced it.
  This test does not import the new observer/backfill implementation.
- `phase7-tests/health.test.mjs`: three expected status checks print FAIL although
  Node marks the file passed. Focused rerun reproduced the same output. This is
  a remaining legacy validation gap, not proof of healthy behavior from exit 0.

No unrelated prompt, policy, health, scope or test assertions were edited to
turn these results green.

## Limits

- Historical data are per-file snapshots, not an atomic provider-billing export.
- Known total excludes 181 calls with missing total; missing protocol/reasoning/
  cacheWrite remains explicit. Normalized zero in a failed-attempt snapshot does
  not establish that the upstream provider billed zero.
- Content byte shares are not exact per-category tokenizer or monetary shares.
- Provider/model/endpoint/protocol in the live observer are explicit route config
  evidence; llm/stream does not expose the resolved outbound wire payload.
- The synthetic isolation trials are not a full replay of the 47.67-billion-token
  workload, nor proof that all original tasks would pass with less context.
