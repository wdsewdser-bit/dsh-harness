# Opt-in verifier session-workspace scratch prototype

Staging only; independent security review pending, no production deployment or
default enablement. Legacy mode is unchanged. Session-workspace opt-in derives
scratch from real current session cwd plus .dsh-verifier-scratch/sessionId.
Only exact caller-native roster ID/name with groupId verifier can locate or use
the scratch exception. Current cwd must be an existing absolute directory,
session label path-safe. No DSH_HOME/global workspace fallback, scope grant,
lease, sandbox override, new writable root or product checkout setup.

Read-only verifier_scratch tool returns exact root/ownerSessionId; it does not
create files. It is registered through real per-agent tools lifecycle and
revalidates native ownership on every call. Guard checks reserved namespace
before ordinary task/static scopes and TEMP fallback. Native real target and
display target must both resolve into own exact root, including missing leaves
resolved through nearest existing real ancestor; junction redirection refused.
Explicit operator wildcard/one-turn privilege keeps its existing precedence.
This is not an OS ACL or isolation from explicitly privileged operators.

Backup backups/verifier-session-scratch-20261014, closeout backup
backups/verifier-session-scratch-closeout-20261014. Changed staged web/headless
write-scope-guard.mjs and phase11-tests/verifier-session-scratch.test.mjs.
New9test prototype fails8/9 before implementation; after implementation new9
plus existing9 pass18/18. Real native roster group resolution remains covered
by prior actual-TeamRoster test. Full canonical offline suite must pass before
starting isolated host; no concurrent host while suite runs.

## Bounded live pre-registration

Fresh home output/live-replay-20261012/verifier-session-scratch-20261014,
port40125,12min/32actual-provider-terminal cap, workspace-write/ask unchanged.
Only staged guard is overlaid on production plugin copies; enable new mode only
in isolated guard config row. Native app is read-only junction/no native overlay.

Root creates actual verifier v1. Verifier calls locator, reads initially absent
own probe, writes exact marker, reads back, reads product path absent, writes
product path expected refusal. No task/plan/lease/privilege, no retry or alternate
paths. Require real native locator ownerSessionId and child ID, successful
controlled native write/read and physical file marker; product denied/absent.
Root then creates one non-verifier lead alpha-probe in alpha group with exact
locator-derived verifier root in its prompt. Peer calls locator expected
unavailable, reads a missing peer-deny file under verifier root and attempts
controlled write expected refusal. Its actual caller identity/group must be
confirmed from native spawn receipt. Peer-deny file remains absent; verifier
positive file unchanged. No shell bypass, global TEMP scope or permission change.

Preserve failed receipts; stop host, collect native tool events, verify only
guard overlay, stable production-file signatures and bounded request count,
delete clone credential, then machine assert. This is a prototype live path,
not independent security acceptance or production enablement. Shell/junction
branches have focused offline tests, not yet claimed live coverage.

Full canonical offline result:238files1571tests/1570pass/0fail/1existing skip,
output/regressions/2026-10-14T20-21-02-876Z-6f526bef/summary.json, actual exit0.
Guard web/headless SHA256 E116CBD30B83B1FA1A6726D91A57CCEDB59D8073906245FE4A580116BB167859.
Production guard remains18C91C2766ED909B1AF29373B9C1D19223CA0E84AE419A9F08160E819B359416.
Coupling audit marks guard alone-ok; existing Strict coupled group unchanged.
Prepared isolated config only enables new mode; prepare.json describes initial
pre-overlay state, not the final fixture. Judge actual before/after hashes and
config delta with this protocol, not that initial description.

First isolated probe did not pass. Native locator returned correct owned root,
but both writes failed FS_WRITE_SCOPE_CONFIG_INVALID: the fixture appended a
second guard row whose config replaced, rather than merged, the original config
and omitted scopesFile. No scratch file was created. Product denial is NOT a
valid negative permission result from this invalid config. No peer phase ran.
Preserve first verdict passed=false/native events;12terminals, host stopped
20:27:51.979Z, credential deleted. Do not modify source to allow invalid config.

Replacement fresh home verifier-session-scratch-ready-20261014 repeats same
scenario/cap32, same staged guard hash. Insert mode INTO original guard config,
preserving scopesFile/controlDir/enforce and other existing settings. Before
start, parse actual YAML and prove exactly one guard row with mode enabled and
existing isolated scope file. No source changes or repeated full suite needed.

## Native isolated result

Replacement passed20/20 assertions,19 actual provider terminals(cap32). Root
session-29ad6cb0-3674-4ba2-9f15-350740bbbd77, actual verifier
91bc4d2f-26cf-47fc-acfa-71433423276f/tier1/group verifier, actual non-verifier
56d82df0-35c8-4e7a-b206-c5b910a75b82/tier1/group alpha.

Verifier locator seq16/result17 returned own session root. Native write26/result27
succeeded, read31/result32 returned the exact marker, and independent physical
file read is byte-exact VERIFIER_SESSION_SCRATCH_20261014. Product write41/result42
was refused for missing declared scope/active approved plan lease; product file
is absent. No permission override, lease, scope grant, shell or run_code used.
Peer locator16/result17 returned okfalse/unavailable; peer write23/result24 was
refused with verifier-session-scratch-owner-or-path-mismatch. peer-deny.txt
is absent, positive probe marker unchanged. Both children and root finished
native turns; final root turn-end67. Collector63events/3sessions.

Initial acceptance parser incorrectly selected native read/write args.path
instead of actual args.file_path, producing four false negatives despite native
receipts and physical success. Preserve verdict-harness-field-failed.json.
Change only selector to actual native schema, retaining exact actor, path,
isError, content, chronology and refusal checks; rerun same stored evidence
without new model requests. Final assert exits0, verdict.json passedtrue.

Replacement host exec91553/PID44520 stopped requested-stop20:32:00.129Z, wait
exec96127/76597 terminal, credentialCopyDeletedtrue/stillPresentfalse. First
failed host exec85661/PID42560 and wait69418 also terminal/cleaned,12terminals.
Actual model requests this prototype turn total31: failed12 plus replacement19.
No hidden rerun is counted as success. Protected762 production files unchanged;
six key before/after plugin hashes stable, only staged guard overlay different.
Native app untouched/read-only junction; production mode not enabled.

## Remaining Gate

This closes the opt-in scoped native write/read/product/peer refusal prototype,
not production D-3 under default legacy mode or independent security acceptance.
Do not deploy/enable by copying this guard without a reviewed config decision.
Independent security review remains pending: reserved namespace/ordinary scope
fallback, trusted operator precedence, native target reparse/TOCTOU behavior,
agent tool lifecycle, and multiple Team/workspace ownership deserve review.
Shell and junction cases have offline coverage, not actual-provider live claims.

Scratch artifacts are inside the session workspace and can appear as untracked
repository files. This prototype does not mutate .gitignore/.git/info/exclude,
alter commit delivery filters or auto-delete verification evidence. Integration
must prevent accidental product commits of these artifacts before enablement.
The locator remains read-only; do not silently add repository mutations to it.
