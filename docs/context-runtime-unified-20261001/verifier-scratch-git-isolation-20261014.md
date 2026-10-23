# Verifier scratch Git delivery isolation gate

Staging opt-in only, default legacy unchanged. Follow-up to
verifier-session-scratch-20261014.md: scratch inside a Git workspace must not
accidentally become a product commit. The read-only locator must not edit
.gitignore, .git/info/exclude, repository config, index, or evidence itself.

For the current real session cwd, identify nearest .git directory/file and
confirm actual Git top-level agrees. Non-Git workspaces have no Git delivery
surface. For Git workspaces require whole .dsh-verifier-scratch/ namespace ignored
and no namespace entries in index or HEAD. Revalidate every permission check,
not cached approval. Missing/corrupt Git, unknown root, timeout, oversized/error
output, tracked artifacts or missing ignore fail closed. Locator reports
verifier-scratch-repository-isolation-required; normal guard write is refused.

Read-only bounded Git queries clear inherited repository/index/object routing
but preserve configured global/system/count Git configuration so ignore semantics
match normal staging. Disable optional locks/fsmonitor, tracing and lazy fetch;
no interactive credential prompts. No shell, config rewrite, repository mutation or permission
override. Physical namespace spelling is exact: Windows case aliases must not
cause a lower-case synthetic check to miss files with case-sensitive Git rules.
Explicit operator wildcard/active privilege retains original override precedence.
This prevents ordinary accidental git add -A inclusion, not a deliberate trusted
operator's git add -f, later config changes after last check, or arbitrary OS
adversaries. Those remain independent review/delivery boundary concerns.

Backup backups/verifier-scratch-git-isolation-20261014. Stage changed only
web/headless write-scope-guard.mjs and phase11-tests/verifier-session-scratch.test.mjs.
New missing-ignore/tracked/remove-ignore cases reproduced3fail before code change.
Focused tests use actual fresh Git repositories, index/HEAD and linked worktree
files, not textual regex proof. Locator calls preserve exclude file bytes.

## Bounded native pre-registration

Fresh home output/live-replay-20261012/verifier-scratch-git-gate-20261014,
40125/12min/24actual-provider-terminal cap, workspace-write/ask unchanged,
only staged guard overlay plus isolated mode inserted into original guard config.
Full canonical offline suite must pass before start; hosts serial.

Phase1 root spawns exactly one verifier v1, prompt locator only then end. Fresh
Git workspace has no namespace ignore. Require actual authenticated v1 native
locator returns isolation-required and no files are created. Collect turn-end,
preserve real receipt and compare clone exclude/index/HEAD bytes unchanged.

Controller then explicitly appends the namespace exclude rule to this isolated
Git metadata only; separate fixture operation, NOT locator behavior. Phase2 root
action wakes original v1 without respawn, asks locator/read absent/write exact
VERIFIER_GIT_ISOLATED_20261014/readback/end. Require same native child ID and
successful controlled native write/read/physical exact marker without grants.
After host stop, actual git add -A must exclude scratch, with no tracked scratch
in index or HEAD. Preserve failures, stable plugin/production guards, cleanup
clone credentials and bounded request counts. No production writes/deployment.

## Independent review and reported-path repairs

The authorized Sol/high read-only review reported three P1 defects in the old
3C46E83D source: scratch carriers skipped bound-worktree checks for Git writes;
Move/Rename did not consistently check their source; link creation and existing
hard links could make a writable scratch name alias a product file. Review used
real parser/hook probes, not destructive shell execution or production changes.

Repairs in staging guard DAB9AA0098A09DAD1378CC50BA2D1340753A9E5F5BF573CF1866E2A50DB8FC33:
- Git writes in non-operator session mode check each parsed invocation, including
  nested scripts, against the actual read-only Git top-level and exact task-bound
  worktree. Native membership lacking tier cannot skip this check. Unknown/local
  Git config carriers fail closed. Directory-changing Git shell compositions are
  refused rather than approved against the initial cwd.
- Move/Rename check both the source and destination; Copy still checks only its
  mutation side. Literal targets in approved scripts are checked in new mode.
- New mode refuses link/unknown New-Item types, including nested approved scripts;
  existing owned scratch regular files with nlink > 1 are refused by native
  write/edit and shell checks. Explicit operator overrides retain their priority.

Six new red cases reproduced all three categories (21 pass/6 fail,
output/regressions/2026-10-14T22-18-05-300Z-7c290c4a). Reviewer then found the cwd
composition variant; its red run was 28 pass/1 fail,
output/regressions/2026-10-14T22-21-12-989Z-ffa7c07f. Final focused run: 4 files,
48 pass/0 fail, output/regressions/2026-10-14T22-21-42-622Z-426a955a.
Reviewer independently read the final hash and confirmed the three reported
paths, including cwd propagation, closed. This is not a shell-syntax-complete,
concurrent-reparse/TOCTOU, OS ACL or production-enablement guarantee.

Correction to review hash scope: reviewer confirmed AF0B447C, before the root
agent additionally reproduced the quoted `& 'Set-Location'` invocation variant
(28 pass/1 fail, run22-27-40-50ae96c6). The two-line predicate repair also checks
quoted command-position tokens, not quoted data arguments. Current DAB9AA00
focused run is 48 pass/0 fail, run22-28-10-b7e4efe1. This last syntax extension
was root-verified, not independently re-reviewed. The prior AF0B full suite
passed 1590/1591 with one existing skip; it is not the current hash's full result.

Prior20/20 native prototype was older source E116CBD3 and is not a current
gate-enabled native acceptance claim. Final full regression and bounded native
precondition validation are tracked separately below when complete.

## Current-source full regression

DAB9AA00 full canonical regression completed with exit0: 238 files, 1591 tests,
1590 passed, 0 failed, 1 existing skip. Evidence:
output/regressions/2026-10-14T22-28-45-896Z-6ecb40ba/summary.json.
Source and scope configuration stayed frozen during this run.

## Live second-phase instruction clarification

Phase1 authenticated v1 locator returned isolation-required and native turns
ended without mutation. Controller captured unchanged Git bytes then explicitly
published only the isolated exclude rule. First phase2 action produced zero new
locator/mutation calls: the model interpreted phase1's once-only limit as a
session-wide limit and reused the old refusal. This is preserved in
tool-events-phase2-no-call.jsonl, not labeled as a new guard refusal or success.
Before any additional prompt, provider ledger showed 12 terminals of cap24.
The new phase clarification authorizes exactly one NEW current-configuration
locator call on the same member, then the already registered read/write/read
sequence. No sandbox/grant changes and no cap increase. This is a prompt scope
repair backed by zero phase2 native calls, not blind repeated tool execution.

## Native gate result

Current-source isolated native gate passed 20/20 checks:
output/live-replay-20261012/verifier-scratch-git-gate-20261014/verdict.json.
Same authenticated verifier 82929bb7-f575-4d40-8590-073a0423fe71, tier1/group
verifier, first returned isolation-required; after controller publication and
the documented phase clarification, a new locator call returned its own root.
Native read confirmed absent, write succeeded, read returned the exact marker,
and the physical bytes match. No shell/run_code, grant, scope or product writes.
Child turn/end62 and root turn/end91 preceded controller stop.

Git snapshots confirm locator calls did not change exclude/index/HEAD/config;
only the explicit controller publication changed exclude. Ordinary git add -A
after host stop staged 0 files and tracked 0 scratch files. Isolated guard hash
stayed DAB9AA00; the other five key plugins stayed production-identical. Driver
guard protected 762 production files without drift.

21 actual provider terminals of cap24, one host PID44864, requested-stop at
2026-10-14T22:37:05.734Z. Controller driver exited0. Host code1 is the driver's
documented taskkill /T /F stop, not a claimed graceful exit0. Final collection
contains63 events/2 sessions. Clone credential deleted/stillPresentfalse;
40123/40124/40125 have no listeners and the existing user8788/PID3008 remains.
Both wait sessions and host exec reached real terminal states. Stage closeout
pending0; no production deployment, enablement, commit or push.

Scope: the opt-in prototype, reported-path shell repairs, current offline
regression and native Git isolation precondition are verified. Default legacy
production D3 is not closed by this run; no global sandbox widening occurred.
Shell syntax completeness, concurrent namespace/link substitution (TOCTOU),
operator force-add and later Git configuration changes are not proved safe by
this gate. The final quoted-command predicate extension was root-tested after
the independent reported-path review, as noted above.
