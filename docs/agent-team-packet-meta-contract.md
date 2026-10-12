# Agent Team acceptance packet meta contract

Updated: 2026-09-28

This file defines the fields the control plane injects into
`team_acceptance_packet` records. The definitions below describe the current
implementation in `team-control-plane.mjs`; callers must not treat them as
submission fields.

## Platform-injected fields

The control plane owns these fields in `packet.meta`:

| Field | Meaning |
|---|---|
| `packetVersion` | Schema version of the packet envelope. It is currently `2`. |
| `revision` | Revision of the packet id. The first write is `1`; a colliding id is allocated a new `-rN` id and the next revision is recorded. |
| `supersedes` | The previous packet id when this write replaced an id collision, otherwise `null`. |
| `contentDigest` | A SHA-256 content fingerprint described below. It is not a signature and does not establish trust. |
| `contentDigestVersion` | Digest contract version. New packets use `2`. Packets without this field are legacy `v1` and are not independently recomputable. |
| `metaInput` | A copy of the caller-provided `meta` object before platform keys were injected. It is the value used in the `v2` digest input. |

These keys are overwritten after the caller's `meta` object is copied, so a
caller-supplied value for any of them is not authoritative.

## contentDigest v2 algorithm

For `contentDigestVersion: 2`, the implementation first normalizes the stored
packet payload and then hashes a recursively key-sorted canonical JSON value:

```text
canonicalize(value):
  array  -> canonicalize each item in order
  object -> sort own keys, then canonicalize each value
  other  -> value unchanged

sha256(JSON.stringify(canonicalize({
  kind: row.kind,
  group: row.group,
  taskIds: row.taskIds,
  commitSha: row.commitSha,
  requirements: row.requirements,
  checks: row.checks,
  files: row.files,
  screenshots: row.screenshots,
  resourceScan: row.resourceScan,
  risks: row.risks,
  blockers: row.blockers,
  meta: row.meta.metaInput
})))
```

The hash is computed from the same normalized values that are stored on the
packet row, so a consumer can recompute it without recovering any discarded
raw input. `metaInput` preserves the caller-provided `meta` object before
platform injection. `contentDigest` therefore covers the packet payload and
the caller-provided meta, but not `packetVersion`, `revision`, `supersedes`,
`contentDigestVersion`, `metaInput`, or the injected `contentDigest` itself.

Legacy packets written before `contentDigestVersion: 2` remain `v1` records.
Their digest cannot be independently recomputed because the pre-injection
`meta` was not stored. Do not rewrite or reject a legacy packet solely for
that reason.

The algorithm is an integrity check against accidental drift. It does not
authenticate the submitter or prove that the referenced files, commit, or
evidence are trustworthy.

## Caller guidance

- Put caller-defined context in `meta`; do not attempt to author the four
  platform-owned keys.
- Put resource-scan data in `resource_scan` as an object. It is not an array.
- If a consumer needs to recompute a `v2` digest, reconstruct the object above
  from the stored packet row and use recursive key sorting before
  `JSON.stringify`.
- A verifier that cannot recompute the digest must not reject a packet solely
  because the platform-owned digest cannot be reproduced. It should record the
  limitation and verify the underlying payload instead.
