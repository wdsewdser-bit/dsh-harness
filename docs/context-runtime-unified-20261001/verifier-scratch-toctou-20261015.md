# Verifier Scratch Mutation Boundary

## Authorization and Current Verdict

Staging and disposable fixtures only. No production writes, service restart,
sandbox widening, provider request, deployment, commit or push. Production
session-workspace mode remains disabled. The existing prototype's positive
functional tests do not prove protection against external namespace changes.

Confirmed vulnerable interleaving, not a fixed-result claim:
`output/verifier-scratch-toctou-20261015/result.json`.
The real DAB9AA00 guard accepts an initially owned scratch target; the fixture
controller replaces an approved ancestor with a junction to a fake product
directory in the same fixture. The actual unmodified LocalFileSystem writes
the marker into that fake product directory. A subsequent guard check rejects
the path. That later rejection does not undo the first write.

This is a deterministic controller interleaving, not a claim about concurrent
thread scheduling, real-provider behavior or damage to a real product. The
probe exited0 because it reproduced the defect, not because the backend is safe.

## Source and Isolation

Native `dsh-fs-local/lib/index.js` SHA256:
`63FBB41D2C33E07111884B798BE507E68C2752ACAB8249C821C20ADE436E894F`.
`writeText` and `editText` serialize by targetKey string, then perform
path-addressed mkdir/open/link/rename or Windows replace. That lock cannot
coordinate a separate actor renaming an ancestor. Atomic publication protects
file contents, not the identity of every directory component.

The staging fs-local file is not an independently writable native source:
filesystem inspection reports shared hard-link/production aliases. Never patch
it in place. Any experiment needs a physical byte copy outside node_modules
and a narrowly pinned module overlay. Existing native-overlay.mjs demonstrates
the loading mechanism but its target list does not currently include fs-local.
Use explicit host `--import`, not inherited NODE_OPTIONS for future model runs.

## Decision Gate

The remaining route needs independent read-only advice about Windows stable
directory identity and reparse-point changes. Do not equate another realpath,
a per-key JavaScript lock, final-leaf no-follow, or a pre-rename check with an
atomic containment guarantee. A native handle-based design must address both
ancestor replacement and mutation of an already opened directory's reparse
metadata. If the available runtime cannot enforce that, state the limitation
or choose an explicit fail-closed/isolated-execution route rather than claiming
the opt-in mode is production-ready.

Minimum acceptance before changing the production decision: reproduce the old
failure, reject that interleaving without fake-product modification, and verify
normal create/read/edit, createIfAbsent collision, atomic update, cleanup and
error release. Repeatable fixture tests precede any bounded real-host run.
No new host run or credentials are required for the present design decision.

## Route Decision Status

The read-only advisor returned intermediate findings, but its wait was aborted
and its agent is no longer available in the runtime. No TASK_TERMINAL report
was received. Do not count this consultation as a completed independent review.

Root verified Microsoft's CreateFileA sharing documentation: access to
attributes/extended attributes is not constrained by dwShareMode. Therefore
holding directory handles without shared DELETE or WRITE must not be presented
as a proven prohibition on reparse metadata changes.
Source: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
Related filesystem specification:
https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165

Two materially different routes remain: preserve disk scratch functionality via
a bounded Windows handle-relative mutation helper, or deny new-mode mutations
until that backend is available. The former needs a new native capability and
an acceptance matrix; the latter intentionally removes the prototype's write
functionality. No production or staging feature behavior has been changed to
silently choose one. The recommended route is preserve functionality with an
isolated helper prototype, with production mode still disabled throughout.

## Authorized Capability Prototype

User accepted the recommended preserve-function route. Isolated source:
`output/verifier-native-capability-20261015/Capability.cs`; driver `test.ps1`.
No production or staging backend is replaced. All files written by tests are
fresh disposable fixtures. Native-source SHA remains 63FBB41D unchanged.

The x64 C# prototype opens an authorized existing physical root, checks the
opened object's final path, then uses one-component NtCreateFile calls with
RootDirectory, OBJ_DONT_REPARSE and FILE_OPEN_REPARSE_POINT. Publication uses
FILE_RENAME_INFORMATION with the parent handle. No path-based write fallback.
This is not a general root authorization service: the controller supplies the
root capability. Temp file cleanup uses file-handle disposition.

Final current test8/8 passes: create, create collision preserves content, atomic
replacement, pre-open ancestor junction refusal, failed-publication cleanup,
actual in-place reparse mutation after parent validation, no fake-product write,
and subsequent relative create failing closed. The last test proves mutation
was successfully applied, not merely that the fixture failed to modify it.
The native refusal was NTSTATUS C0000280. This directly covers the disputed
share-mode-only assumption without relying on it as the security guarantee.

Evidence: prototype result.json, inplace-error.txt and retained fixture path in
the result. Each test invocation creates a fresh GUID fixture. This is scoped
fixture acceptance only. Read/edit/version tokens, ACL preservation, directory
creation, cancellation and DSH dispatch/root ownership integration remain work
before replacing LocalFileSystem. An independent read-only review of the
prototype's concrete handle/FFI/cleanup risks is pending, not assumed passed.

## Independent Prototype Review Result

Review completed read-only (no fixture execution); not approved for integration.
The eight checks are only the exercised cases, not acceptance of the backend.
Reported gaps to fix before integration:

- P1: raw RootDirectory handles in native structures lack Write/Dispose lifetime
  synchronization or SafeHandle reference pinning. Concurrent disposal/reuse is
  outside direct SafeFileHandle PInvoke argument protection.
- P1 static risk: temp Links==1 is a snapshot, and sharing read/write does not
  establish immunity to later hard-link insertion or other open writers.
- P1 acceptance gap: the after-temp-create/before-rename reparse mutation is
  untested. Rename RootDirectory has its own resolution semantics and does not
  automatically inherit NtCreateFile's no-reparse flags. Investigate the supported
  NULL root + simple leaf same-directory rename form, then test it explicitly.
- P2 integration contract: reopening a controller-supplied path and comparing
  final path does not bind the previously authorized object. A trusted bootstrap
  must transfer a live capability or verify independently bound object identity.
- P2 cleanup: Open's post-create Check failure precedes the caller's cleanup
  region and can leave a temp file; cleanup errors may mask the original error.

References from the reviewer: Microsoft's SafeHandle.DangerousGetHandle,
FILE_LINK_INFORMATION and FILE_RENAME_INFORMATION documentation. These findings
are grounded static risks/gaps, not claims of demonstrated exploitation. No
unreported outcome is treated as a completed negative test. Prototype source is
unchanged after review, so fixes and additional tests remain pending.

## Reported-Path Repair Iteration

Subsequent isolated implementation (not backend integration): Write/Dispose now
share a lifecycle gate, rejecting reentrant dispose/write. A new constructor
duplicates a supplied live authorized root SafeFileHandle; the current fixture
captures the root, constructs the capability, and closes the caller's handle.
The legacy path constructor remains fixture-only, not a production authority.

New temp files use no sharing and are marked delete-pending before content is
written; this Windows fixture reports zero links in that state. Post-create
validation failure closes the pending file. Cleanup errors attach to a primary
exception rather than masking it. After all writes/flush finish, pending state
is cleared for publication. Rename now uses RootDirectory=NULL and a simple
leaf, with a buffer at least the x64 struct's24 bytes.

Actual current fixture checks14/14 passed. This includes reentrant dispose
refusal without losing later usability, injected post-create exception cleanup,
and real hardlink creation refused while the temp is pending. Retained failed
run `result-publish-mutation-not-applied.json` is not overwritten as success.
During publication-stage injection, FSCTL_SET_REPARSE_POINT returned145
(directory not empty): injection was NOT applied. The new result records that
fact explicitly; it verifies filesystem refusal and normal same-directory
publication, not successful post-temp-create reparse injection containment.
The separate before-temp-create mutation still actually succeeds and the
following NtCreateFile fails closed.

Intermediate implementation failures were addressed: pending temp link count
is not the ordinary one-link state; FILE_DELETE_ON_CLOSE remained incompatible
with successful publication and was removed in favor of explicit pending state.
No failed intermediate implementation is treated as acceptance. Latest result
fixture-cbfe3825edb64b04852a5d668fdc8141. Targeted independent patch recheck is
pending; do not mark the five issues globally closed or deploy this prototype.

Targeted reviewer recheck has now completed: reported lifecycle and post-create
cleanup branches are closed; live authorized-handle entry closes the reported
reopening-contract gap; temp sharing/link protection is supported on this tested
filesystem only. NULL-root single-leaf publication removes the identified
target-directory reopen design, while the failed publication-stage injection
remains explicitly limited evidence. Reviewer ran no tests. A final root-run
adds single-character leaf publication to the same fixtures:15/15 passed.
Capability source remains609A934D37CB6044D3B582D8B159ADA5AE4DD96878DA314FC0D1D93A033BAE09.

This authorizes continued isolated development only, not production integration.
Remaining adapter contracts: trustworthy Team/session root capability acquisition,
native observation/version semantics, read/edit/ACL/mkdir/cancellation mapping,
platform/filesystem capability detection and deterministic error propagation.
No staging or production package was patched by this prototype iteration.

## Read and Observed-Edit Prototype

Subsequent isolated prototype adds bounded strict UTF-8 handle-relative reads
(4 MiB maximum), SHA256 observation tokens, and single-occurrence literal edits
requiring the previously observed token. Calls share the capability lifecycle
gate. Missing observations and stale tokens refuse mutation; line endings are
not normalized away. Existing leaf hardlinks and ancestor reparses are refused.

Current fixture result22/22 passes, fixture-7b3d122e4f5f420ab8dde5d21a561222.
The seven added checks cover read/token, observed edit, stale edit refusal,
unobserved edit refusal, UTF-8/CRLF, hardlinked reads and ancestor-reparse reads.
The prior five-risk independent recheck predates these additions; do not claim
it reviewed the new read/edit methods. These are prototype semantics only:
`cap-sha256:` tokens are not the native backend's FsVersion representation,
exceptions are not yet mapped to FsError, and before/after/outcome plumbing is
not connected to ctx.fs or fs/observed. Serialization is within this capability,
not a global CAS transaction against all external writers during publication.
ACL inheritance/preservation, mkdir, cancellation and platform detection remain
unimplemented adapter obligations. No provider/host run or full regression was
performed for this isolated helper-only iteration.

Project status entry updated in `docs/unfinished-summary-20261012.md` with a
dated increment. Historical project totals below that increment are preserved.

## Directory and Cooperative Cancellation Prototype

Current helper fixture31/31 passes, fixture-b174a3479e4041c8982977dd0c338b0c.
Directory creation validates the full relative path before mutation, then uses
per-component NtCreateFile FILE_OPEN_IF through directory handles. Existing
directories are idempotent; reparse ancestry and invalid components are refused.

WriteCancelable, ReadCancelable, EditCancelable and EnsureDirectory accept .NET
CancellationToken. Checkpoints cover entry, traversal, chunked text I/O and the
pre-publication boundary. Cancellation before replacement preserves old bytes
and pending-temp cleanup; cancelled reads release handles and allow later reads.
After publication commits, edit readback deliberately does not report a late
cancellation as if no write happened. This is cooperative cancellation, not
interruption of an in-progress native syscall or rollback of already committed
operations. Directory creation is not transactional: previously created valid
components may remain when cancellation happens between components.

Nine added checks cover mkdir idempotence/invalid-path side effects, pre-cancelled
write/mkdir, pre-publication preservation/cleanup, junction mkdir refusal, read
cancellation release and pre-cancelled edit preservation. Platform detection,
ACL preservation, native observation/error/abort mapping and actual DSH service
integration remain pending. No new host, provider request, native package edit
or full-suite claim is made by this helper-only iteration.

## DACL and Platform Detection Prototype

Current fixture39/39 passes, fixture-ece0e22fa700488bbd6eef97ffe4a5af.
Constructors now validate Windows x64 and actual root-handle volume information:
only NTFS reporting persistent ACL and reparse support is accepted. Unknown
query results or unsupported conditions refuse; there is no path-write fallback.
The non-Windows/ReFS/missing-flags negatives are validator tests with supplied
values, not claims of running this helper on those operating systems/volumes.

Replacement snapshots an existing leaf's DACL by an opened source handle with
READ_CONTROL. Only actual object-name-not-found skips the snapshot. Temp handle
requests WRITE_DAC/READ_CONTROL; SetSecurityInfo copies the DACL and source
protected/unprotected state before content is written. Security descriptor
memory from GetSecurityInfo is released with LocalFree. API failures refuse
publication and flow through pending-temp cleanup.

New checks compare exact Access-section SDDL for inherited and explicitly
protected ACLs before/after update. A fixture exception before ACL application
verifies old content/DACL preservation and temp cleanup; it does not pretend to
be a real OS permission-denied API call. Four platform and four ACL checks were
added. Targeted independent ACL/platform review is pending. Owner, SACL, other
ReplaceFile metadata and races against an external security-descriptor editor
are not covered. In particular, DACL copy is not a promise to retain an existing
file's entire security descriptor or native replacement semantics.

Sources: Microsoft GetSecurityInfo, SetSecurityInfo and
GetVolumeInformationByHandleW documentation. Production native package remains
unmodified; no deployment, service start, sandbox expansion or provider call.

Targeted review completed: no explicit new DACL leak was found in pointer
lifetime, permissions or pre-content failure handling. Reviewer identified that
64-bit pointers alone also accept ARM64. Root repaired this to require actual
RuntimeInformation.ProcessArchitecture.X64 at native entry points, and added an
ARM64 validator negative. Final current run40/40 passed,
fixture-5b986b55b6524312b9e9294e96e65523. The reviewer did not execute tests or
independently re-review the final small architecture predicate change.

These results close the reported architecture gate gap within the prototype;
they do not expand supported systems, imply native SetSecurityInfo failure was
actually induced, or solve full owner/SACL/replacement-metadata compatibility.
Project status table is synchronized to40 checks and these limits.

## Owner and Group Prototype

Current fixture43/43 passes, fixture-aa13ea7186c348cd96f82e234924a83a.
The existing handle security snapshot now obtains OWNER/GROUP/DACL together;
all SID/ACL pointers remain backed by the retained descriptor. Missing owner
or group refuses update. Temp requests WRITE_OWNER in addition to its previous
access mask and restores identities and DACL before writing content. Native API
failure refuses publication; no token privilege is enabled. A second snapshot
checks EqualSid for both identities and the protection bit after application.

Three new checks verify original identities, unchanged DACL through identity
update, and a non-default group (Everyone) set explicitly in the fixture then
preserved through replacement. The fixture initially tried PowerShell Set-Acl
for the group change, which requested unavailable SeSecurityPrivilege; it was
not enabled. Fixture setup now uses the narrow GROUP-only SetSecurityInfo call.
That setup failure is retained as a documented failed preparation, not passed
as a backend test. Foreign-owner restoration failure is still only a code-path
guarantee, not a claimed real OS failure test.

SACL, mandatory labels and other ReplaceFile metadata are not preserved by this
implementation. It remains unsuitable as a general LocalFileSystem replacement;
an adapter must not silently treat OWNER/GROUP/DACL as the entire security
descriptor. The current prototype does not alter any production/staging native
package. A targeted read-only recheck of this new identity path is pending.

Identity-path review subsequently completed with no explicit new pointer,
permission or error-handling defect found. It supports the described current
identity/Everyone-group cases only; no foreign-owner denial execution is added
by reading the code. Reviewer did not rerun tests or modify files. Root's final
native production hash remains63FBB41D (unchanged), with no host/credential work.

## End-to-End Acceptance Scope Correction

The remaining work is now one continuous implementation/integration/verification
package, not repeated prototype-only deliveries. It must retain actual physical
scratch artifacts consumable by native tools; an in-memory version index with
no persistent physical-path semantics is not accepted as an equivalent result.

The previous discussion elevated complete audit-SACL preservation into a blocking
requirement without establishing that the existing backend promised it. The
installed backend explicitly copies DACL and uses ReplaceFileW; Microsoft's
documented preservation list covers creation time, short name, object ID, DACL,
security resource attributes, encryption/compression and otherwise absent named
streams. It does not explicitly promise full owner/audit-SACL preservation.
Source: [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).

Acceptance therefore compares the scratch adapter to that documented baseline,
not to an invented full-security-descriptor guarantee. Audit SACL remains
unread/unpreserved and must be disclosed; no privilege enabling is allowed.
Baseline metadata not safely supported must be detected by handle and rejected,
with unknown/error queries failing closed rather than becoming "absent". Normal
physical create/read/edit must remain usable; unsupported profiles are not a
license to remove write functionality or revert to unsafe path-based mutation.

## Isolated Native Integration Closeout (2026-10-16 UTC)

The scratch-only opt-in host plugin is implemented under
`output/verifier-native-capability-20261015/host-plugin.mjs`; it is not installed
in production or shared node_modules. It binds the real tools execution actor,
native verifier membership and session root, checks the readonly locator, opens
the local root with physical-path/file-ID validation, and routes native text
create/read/edit through the handle helper. Ordinary paths retain their native
backend. Sandbox write restrictions, stale versions, absence observations,
unobserved overwrites, cancellation and unsupported metadata remain enforced.

Final fixture results:138 checks (43 handle prototype,32 ToolRuntime,6 metadata,
8 transport,16 ordinary host-plugin,16 projected observation actor,17 late guard).
The last includes an actual invalid-scope veto with unchanged bytes; native
ToolRuntime preserves its error message but omits this custom guard code.
Do not confuse an initial assertion expecting that omitted code with a bypass.

Targeted review found ordinary cancel-marker path dependence, weak root capture,
NUL publication-before-error and protocol teardown/queue problems. Fixes use
stdin cancellation, root identity checks, prepublication text checks and failed
transport teardown. Later review found pending initialization could survive
disposal and malformed input could leave work running. Root repaired those and
tested actual prepublication cancellation plus queued refusal and helper reap.
The final load-order repair and these root changes subsequently received
targeted independent static review: no explicit actionable issue found,
exactACD2host/BC89runtime hashes verified. Dynamic evidence was reused, not
rerun. See `verifier-native-final-patch-review-20261016.md`; this is not a claim
of complete security review.

Real native host gate:30/30 assertions in
`output/live-replay-20261012/verifier-native-host-20261015/verdict.json`.
One real v1 native session created and read physical bytes, then after fixing a
proven guard-load-order integration defect edited and read the exact AFTER
marker. Its product-path write was refused. Original member/root turn/end events
were collected before shutdown. Both failed earlier phases remain archived;
the raw-actor-object hypothesis was explicitly falsified, not reported fixed as
the live root cause. The successful log shows backend observation fallback.

Actual usage:30 provider terminals across all3 host runs, below the unchanged32
cap;307929ms combined active-host time. All hosts stopped, credentials deleted,
40123/40124/40125 not listening, no helper remained. User8788 PID48096 preserved.
Production8 key hashes stayed unchanged, and the drivers guarded762 production
session/config resources. Normal isolated git add-A staged no scratch files.

Remaining boundaries:controller still prepares the physical per-session root;
Windows x64 NTFS text scratch only; audit SACL preservation is not promised;
unsupported baseline metadata is refused, not discarded. No privilege enabling,
production rollout, default-legacy closure or general shell/TOCTOU proof is
claimed. Existing historical full regression belongs to the unchanged staging
guard, not this new standalone host adapter; it was not rerun or relabelled.

## Superseding Formal Staging Result (2026-10-16 UTC)

The prior output-only/manual-root boundary above is historical. The formal
staging implementation is now complete; current authority is
`verifier-native-stage-20261016.md` and its linked stage-result/live verdict.
The backend is a five-file web/headless bundle in staging with complete
deployment-manifest coverage, explicit single opt-in guard/backend configuration,
trusted handle-relative automatic session-root preparation, and canonical
default regression coverage. No production or shared native package changed.

New staged-bootstrap review reproduced sandbox revocation and failed-init helper
leak defects; both were repaired, regression tested and independently rechecked
closed.189 fixture checks passed. Backend full239-file regression:1592 passed,
0 failed,1 existing skip; final configuration-only follow-up canonical3/3 and
manifest3/3. New real session, no controller mkdir: automatic root/create/read/
observed edit/read and product-veto passed31/31,13 actual model requests below24.
Host/helpers stopped, credentials removed, production8-file hashes and762-resource
driver signatures stable, isolated scratch not staged by normal Git add-A.

The earlier138/30 and manual-controller-root acceptance is not relabelled as
the new source and must not be summed into the new counts. Existing source/
results remain intact. Current limits:Windows x64 NTFS scratch text, audit SACL
not promised, readonly cannot initialize a new controller, directory writer
conflicts fail closed, no complete shell/TOCTOU or production-release approval.
