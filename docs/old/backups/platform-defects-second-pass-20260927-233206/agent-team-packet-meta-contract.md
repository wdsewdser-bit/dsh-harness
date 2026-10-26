# Agent Team acceptance packet meta contract

Updated: 2026-09-27

This file defines the fields the control plane injects into
`team_acceptance_packet` records. The definitions below describe the current
implementation in `team-control-plane.mjs`; callers must not treat them as
submission fields.

## Platform-injected fields

The control plane owns these four fields in `packet.meta`:

| Field | Meaning |
|---|---|
| `packetVersion` | Schema version of the packet envelope. It is currently `2`. |
| `revision` | Revision of the packet id. The first write is `1`; a colliding id is allocated a new `-rN` id and the next revision is recorded. |
| `supersedes` | The previous packet id when this write replaced an id collision, otherwise `null`. |
| `contentDigest` | A SHA-256 content fingerprint described below. It is not a signature and does not establish trust. |

These keys are overwritten after the caller's `meta` object is copied, so a
caller-supplied value for any of them is not authoritative.

## contentDigest algorithm

The implementation computes:

```text
sha256(JSON.stringify({
  kind,
  group,
  taskIds,
  commitSha,
  requirements,
  checks,
  files,
  screenshots,
  resourceScan,
  risks,
  blockers,
  meta
}))
```

The object key order above is the order used by the implementation. `meta` in
that input is the caller-provided `meta` object before the four platform keys
are injected. JavaScript `undefined` properties are omitted by
`JSON.stringify`; arrays and object values are otherwise serialized as
provided. `contentDigest` therefore covers the packet payload and the
caller-provided meta, but not `packetVersion`, `revision`, `supersedes`, or the
injected `contentDigest` itself.

The algorithm is an integrity check against accidental drift. It does not
authenticate the submitter or prove that the referenced files, commit, or
evidence are trustworthy.

## Caller guidance

- Put caller-defined context in `meta`; do not attempt to author the four
  platform-owned keys.
- Put resource-scan data in `resource_scan` as an object. It is not an array.
- If a consumer needs to recompute the digest, it must use the same key order,
  the same JSON serialization, and the pre-injection `meta`.
- A verifier that cannot recompute the digest must not reject a packet solely
  because the platform-owned digest cannot be reproduced. It should record the
  limitation and verify the underlying payload instead.
