# Runtime Closeout, 2026-10-23

This change integrates the completed context/runtime work on top of the current
remote main branch. Existing remote changes are retained, including regression
slow-test selection, test-home isolation, and compact test reporting.

## Delivered

- Native Goal continuation and convergence boundaries, controlled provider retry,
  and recovery of the same Team and its original peers from native journals.
- Authority-bound tool references, SDK catalog discovery, and context episodes.
- Incremental context budgeting, durable no-change detection, indexed inbox
  lookup, and bounded hot operation receipts with durable cold recovery.
- Fail-closed sandbox capability loss handling, with no automatic permission
  regrant or reconstruction of a lost sandbox.
- Updated web/headless plugins, explicit native patch manifests, regression
  coverage, and current implementation/acceptance documentation.

## Acceptance And Limits

The accepted local closeout ran 257 test files: 1,754 passed, zero failed, and
one existing optional test was skipped. The bounded native scenario recorded
125 logical requests and 125 transport attempts, including one deliberately
injected HTTP 503. Native cold reads and an independent evidence-registry
readback passed. The earlier three-hour/four-phase Team acceptance remains a
separate historical result.

Production deployment, rollback, reapplication, and fresh-profile loading were
verified before this Git integration. Existing Team state was preserved. This
commit does not deploy or restart a service. Runtime outputs, session journals,
credentials, backups, and raw acceptance artifacts are deliberately excluded.

The historical sandbox-directory deleter is still unknown. The sandbox change
provides fail-closed behavior, not availability restoration or attribution.
Automatic W1/W2 economic switching and SDK core projection remain disabled.

The local accepted closeout report is identified by SHA-256
`e92dc22cbdad84b0af61a51a76098d5fc3c43fb2bf814ec281ecdae03c8b98d7`.
That report is not uploaded with this source change.

## Git Integration Checks

All delivered runtime and native implementations match the accepted local
source bytes. The remote regression runner and its home-isolation tests are
preserved. The plugin-coupling baseline is refreshed after confirming that the
deployed production plugins now match their staged counterparts.

Focused integration checks passed 125 tests across 12 files. Native patch and
plugin coupling checks also passed. The complete isolated-worktree run was not
green: 1,690 passed, 40 failed, and one was skipped. Its failures include missing
private historical evidence/prepared profiles, absolute paths to the original
workspace, and legacy fixtures that import production plugins directly. The
subsequent dependency repair and focused checks do not relabel that full run
as passed. These local fixtures and their raw logs are not part of this commit.
