import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { identityRoleFile } from './team-v14-context-delivery.mjs'

export const ACTIVE_IDENTITY_FILES = Object.freeze([
  'identity-version.json',
  'AGENTS.md',
  'root.md',
  'lead.md',
  'member.md',
  'verifier.md',
])

const HASHED_ROLE_FILES = Object.freeze(ACTIVE_IDENTITY_FILES.slice(1))
const MAX_BUNDLE_BYTES = 256 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/i
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code })
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function assertNoSymlinkComponents(target) {
  const full = resolve(target)
  const parsed = parse(full)
  let cursor = parsed.root
  for (const component of full.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component)
    const info = lstatSync(cursor, { bigint: true })
    if (info.isSymbolicLink()) fail('IDENTITY_SYMLINK_PATH', 'identity path contains a symbolic link')
  }
}

function statSignature(info) {
  return [
    info.dev, info.ino, info.mode, info.nlink, info.size,
    info.mtimeNs ?? BigInt(Math.floor(Number(info.mtimeMs) * 1e6)),
    info.ctimeNs ?? BigInt(Math.floor(Number(info.ctimeMs) * 1e6)),
    info.uid, info.gid,
  ].map(String).join(':')
}

function assertStable(before, after, code, message) {
  if (statSignature(before) !== statSignature(after)) fail(code, message)
}

function assertCasValue(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('IDENTITY_CAS_INPUT_INVALID', field + ' must be a non-negative safe integer')
  }
  return value
}

function assertCasInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('IDENTITY_ACTIVATION_INPUT_INVALID')
  }
  const keys = Reflect.ownKeys(input)
  const proto = Object.getPrototypeOf(input)
  if ((proto !== Object.prototype && proto !== null)
    || keys.length !== 3
    || !keys.includes('expectedControlRevision')
    || !keys.includes('expectedIdentityEpoch')
    || !keys.includes('expectedBundleHash')) {
    fail('IDENTITY_ACTIVATION_INPUT_INVALID', 'activation accepts only the CAS fields and proposal hash')
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('IDENTITY_ACTIVATION_INPUT_INVALID', 'activation fields must be plain data values')
    }
  }
  const expectedBundleHash = input.expectedBundleHash
  if (typeof expectedBundleHash !== 'string' || !HASH_PATTERN.test(expectedBundleHash)) {
    fail('IDENTITY_CAS_INPUT_INVALID', 'expectedBundleHash must be a SHA-256 hex digest')
  }
  const expectedControlRevision = assertCasValue(input.expectedControlRevision, 'expectedControlRevision')
  if (expectedControlRevision === Number.MAX_SAFE_INTEGER) fail('IDENTITY_CAS_INPUT_INVALID')
  return {
    expectedControlRevision,
    expectedIdentityEpoch: assertCasValue(input.expectedIdentityEpoch, 'expectedIdentityEpoch'),
    expectedBundleHash: expectedBundleHash.toLowerCase(),
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function contentDigest(files) {
  const digest = createHash('sha256')
  for (const name of ACTIVE_IDENTITY_FILES) {
    const nameBytes = Buffer.from(name, 'utf8')
    const bytes = files[name]
    const length = Buffer.alloc(8)
    length.writeUInt32BE(nameBytes.length, 0)
    length.writeUInt32BE(bytes.length, 4)
    digest.update(length).update(nameBytes).update(bytes)
  }
  return digest.digest('hex')
}

function decodeUtf8(bytes, name) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('IDENTITY_UTF8_INVALID', name + ' is not valid UTF-8')
  }
}

function validateBundleBuffers(files, totalBytes, maxBytes) {
  if (totalBytes > maxBytes) fail('IDENTITY_BUNDLE_TOO_LARGE')
  const texts = Object.fromEntries(ACTIVE_IDENTITY_FILES.map((name) => [name, decodeUtf8(files[name], name)]))
  let manifest
  try {
    manifest = JSON.parse(texts['identity-version.json'])
  } catch {
    fail('IDENTITY_MANIFEST_INVALID', 'identity-version.json is not valid JSON')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || typeof manifest.identityVersion !== 'string'
    || manifest.identityVersion.trim().length === 0
    || Buffer.byteLength(manifest.identityVersion, 'utf8') > 128) {
    fail('IDENTITY_MANIFEST_INVALID', 'identity-version.json has an invalid schema or version')
  }
  const hashes = manifest.files
  if (hashes === null || typeof hashes !== 'object' || Array.isArray(hashes)) {
    fail('IDENTITY_MANIFEST_INVALID', 'identity-version.json must hash all five identity files')
  }
  const declaredNames = Object.keys(hashes).sort()
  const requiredNames = [...HASHED_ROLE_FILES].sort()
  if (declaredNames.length !== requiredNames.length
    || declaredNames.some((name, index) => name !== requiredNames[index])) {
    fail('IDENTITY_MANIFEST_INVALID', 'identity manifest file set must be exact')
  }
  for (const name of HASHED_ROLE_FILES) {
    const expected = hashes[name]
    if (typeof expected !== 'string' || !HASH_PATTERN.test(expected)) {
      fail('IDENTITY_MANIFEST_INVALID', 'identity manifest has an invalid SHA-256 for ' + name)
    }
    const actual = createHash('sha256').update(files[name]).digest('hex')
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      fail('IDENTITY_HASH_MISMATCH', 'identity hash mismatch: ' + name)
    }
  }
  return {
    manifest,
    texts,
    identityVersion: manifest.identityVersion,
    totalBytes,
    contentHash: contentDigest(files),
  }
}

function readDescriptor(fd, maxBytes) {
  const chunks = []
  let total = 0
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total
    const chunk = Buffer.alloc(Math.min(16 * 1024, remaining))
    const count = readSync(fd, chunk, 0, chunk.length, null)
    if (count === 0) break
    chunks.push(chunk.subarray(0, count))
    total += count
  }
  if (total > maxBytes) fail('IDENTITY_BUNDLE_TOO_LARGE')
  return Buffer.concat(chunks, total)
}

function readStableFile(root, name, remainingBytes) {
  const path = join(root, name)
  if (dirname(path) !== root) fail('IDENTITY_PATH_INVALID')
  const beforePath = lstatSync(path, { bigint: true })
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
    fail('IDENTITY_FILE_INVALID', name + ' must be a regular, singly linked file')
  }
  if (beforePath.size > BigInt(remainingBytes)) fail('IDENTITY_BUNDLE_TOO_LARGE')
  if (!samePath(realpathSync.native(path), path)) fail('IDENTITY_SYMLINK_PATH')

  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const beforeFd = fstatSync(fd, { bigint: true })
    if (!beforeFd.isFile() || beforeFd.nlink !== 1n) fail('IDENTITY_FILE_INVALID')
    assertStable(beforePath, beforeFd, 'IDENTITY_READ_RACE', 'identity file changed before read')
    const bytes = readDescriptor(fd, remainingBytes)
    const afterFd = fstatSync(fd, { bigint: true })
    const afterPath = lstatSync(path, { bigint: true })
    assertStable(beforeFd, afterFd, 'IDENTITY_READ_RACE', 'identity file changed during read')
    assertStable(beforePath, afterPath, 'IDENTITY_READ_RACE', 'identity file was replaced during read')
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !samePath(realpathSync.native(path), path)) {
      fail('IDENTITY_SYMLINK_PATH')
    }
    if (BigInt(bytes.length) !== afterFd.size) fail('IDENTITY_READ_RACE', 'identity file was truncated during read')
    return { bytes, signature: statSignature(afterPath) }
  } finally {
    closeSync(fd)
  }
}

function assertPhysicalRoot(rolesDir, allowedRoots) {
  assertNoSymlinkComponents(rolesDir)
  const rootInfo = lstatSync(rolesDir, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('IDENTITY_ROOT_INVALID')
  const physicalRoot = realpathSync.native(rolesDir)
  if (!samePath(rolesDir, physicalRoot)) fail('IDENTITY_SYMLINK_PATH')
  if (!allowedRoots.some((root) => pathIsInside(root, physicalRoot))) fail('IDENTITY_ROOT_NOT_ALLOWED')
  return { physicalRoot, signature: statSignature(rootInfo) }
}

function encodeBundle(files, validated) {
  return deepFreeze({
    schemaVersion: 1,
    identityVersion: validated.identityVersion,
    contentHash: validated.contentHash,
    totalBytes: validated.totalBytes,
    files: Object.fromEntries(ACTIVE_IDENTITY_FILES.map((name) => [name, files[name].toString('base64')])),
  })
}

function decodeStoredBundle(bundle, maxBytes) {
  if (bundle === null || typeof bundle !== 'object' || bundle.schemaVersion !== 1
    || typeof bundle.contentHash !== 'string' || !HASH_PATTERN.test(bundle.contentHash)
    || bundle.files === null || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
    fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
  }
  const names = Object.keys(bundle.files).sort()
  const expectedNames = [...ACTIVE_IDENTITY_FILES].sort()
  if (names.length !== expectedNames.length || names.some((name, i) => name !== expectedNames[i])) {
    fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
  }
  const files = Object.create(null)
  let totalBytes = 0
  for (const name of ACTIVE_IDENTITY_FILES) {
    const encoded = bundle.files[name]
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
    totalBytes += bytes.length
    if (totalBytes > maxBytes) fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
    files[name] = bytes
  }
  const validated = validateBundleBuffers(files, totalBytes, maxBytes)
  if (bundle.contentHash.toLowerCase() !== validated.contentHash
    || bundle.identityVersion !== validated.identityVersion
    || bundle.totalBytes !== totalBytes) {
    fail('ACTIVE_IDENTITY_BUNDLE_INVALID')
  }
  return { files, ...validated }
}

function getEpoch(state) {
  const epoch = state.identityEpoch ?? 0
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail('ACTIVE_IDENTITY_EPOCH_INVALID')
  if (state.activeIdentity !== undefined && state.activeIdentity !== null
    && Number(state.activeIdentity.epoch) !== epoch) {
    fail('ACTIVE_IDENTITY_EPOCH_INVALID')
  }
  return epoch
}

function requireActor(resolveActor, context) {
  const actor = resolveActor(context)
  if (actor !== null && typeof actor === 'object' && typeof actor.then === 'function') {
    fail('IDENTITY_ACTOR_RESOLVER_ASYNC')
  }
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)
    || typeof actor.name !== 'string' || actor.name.trim().length === 0) {
    fail('IDENTITY_ACTOR_UNRESOLVED')
  }
  return actor
}

function actorKey(actor) {
  return JSON.stringify({
    name: actor.name,
    id: actor.id === undefined ? null : String(actor.id),
    tier: actor.tier === undefined ? null : actor.tier,
    role: actor.role === undefined ? null : actor.role,
    group: actor.group === undefined ? null : actor.group,
  })
}

function requireRootActor(actor, manifest) {
  if (identityRoleFile(actor, manifest) !== 'root.md') fail('IDENTITY_ACTIVATION_ROOT_REQUIRED')
  return actor
}

function snapshotState(controlPlane) {
  if (typeof controlPlane.snapshot === 'function') return controlPlane.snapshot({ history: false, copy: true })
  return structuredClone(controlPlane.get())
}

function readActiveRecord(controlPlane, maxBytes) {
  const state = snapshotState(controlPlane)
  const active = state?.activeIdentity
  const epoch = getEpoch(state ?? {})
  if (active === undefined || active === null) fail('ACTIVE_IDENTITY_NOT_SET')
  if (active.status !== 'active' || !Number.isSafeInteger(active.epoch) || active.epoch < 1
    || active.epoch !== epoch || !Number.isFinite(active.activatedAt)
    || typeof active.activatedBy !== 'string' || active.activatedBy.length === 0) {
    fail('ACTIVE_IDENTITY_RECORD_INVALID')
  }
  const bundle = decodeStoredBundle(active.bundle, maxBytes)
  return { state, active, bundle }
}

/**
 * Create a read-only active identity view and a separate trusted activation API.
 * `resolveActor` is server-owned; request/tool arguments never provide actor
 * identity, role paths, bundle text, or status.
 */
export function createActiveIdentityService({
  controlPlane,
  rolesDir,
  allowedRoots,
  resolveActor,
  maxBundleBytes = MAX_BUNDLE_BYTES,
}) {
  if (controlPlane === null || typeof controlPlane !== 'object'
    || typeof controlPlane.mutateHot !== 'function'
    || (typeof controlPlane.snapshot !== 'function' && typeof controlPlane.get !== 'function')) {
    fail('IDENTITY_CONTROL_PLANE_REQUIRED')
  }
  if (typeof rolesDir !== 'string' || rolesDir.trim().length === 0
    || !Array.isArray(allowedRoots) || allowedRoots.length === 0
    || typeof resolveActor !== 'function') {
    fail('IDENTITY_TRUST_CONFIG_REQUIRED')
  }
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes < 1 || maxBundleBytes > MAX_BUNDLE_BYTES) {
    fail('IDENTITY_BUNDLE_BUDGET_INVALID')
  }

  const lexicalRolesDir = resolve(rolesDir)
  const physicalRolesDir = realpathSync.native(lexicalRolesDir)
  if (!samePath(lexicalRolesDir, physicalRolesDir)) fail('IDENTITY_SYMLINK_PATH')
  assertNoSymlinkComponents(physicalRolesDir)
  const rootInfo = lstatSync(physicalRolesDir, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('IDENTITY_ROOT_INVALID')
  const roots = allowedRoots.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) fail('IDENTITY_ALLOWED_ROOT_INVALID')
    return realpathSync.native(resolve(entry))
  })
  if (!roots.some((root) => pathIsInside(root, physicalRolesDir))) fail('IDENTITY_ROOT_NOT_ALLOWED')

  const readDiskBundle = () => {
    const rootBefore = assertPhysicalRoot(physicalRolesDir, roots)
    const files = Object.create(null)
    const fileSignatures = Object.create(null)
    let totalBytes = 0
    for (const name of ACTIVE_IDENTITY_FILES) {
      const entry = readStableFile(physicalRolesDir, name, maxBundleBytes - totalBytes)
      files[name] = entry.bytes
      fileSignatures[name] = entry.signature
      totalBytes += entry.bytes.length
      if (totalBytes > maxBundleBytes) fail('IDENTITY_BUNDLE_TOO_LARGE')
    }
    const validated = validateBundleBuffers(files, totalBytes, maxBundleBytes)
    const finalRoot = assertPhysicalRoot(physicalRolesDir, roots)
    if (rootBefore.signature !== finalRoot.signature) fail('IDENTITY_READ_RACE', 'identity root changed during read')
    for (const name of ACTIVE_IDENTITY_FILES) {
      const path = join(physicalRolesDir, name)
      const finalInfo = lstatSync(path, { bigint: true })
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) fail('IDENTITY_FILE_INVALID')
      if (statSignature(finalInfo) !== fileSignatures[name]) {
        fail('IDENTITY_READ_RACE', 'identity file changed after read: ' + name)
      }
      if (!samePath(realpathSync.native(path), path)) fail('IDENTITY_SYMLINK_PATH')
    }
    return { ...validated, files }
  }

  const readonly = Object.freeze({
    proposal() {
      const proposal = readDiskBundle()
      return deepFreeze({
        identityVersion: proposal.identityVersion,
        contentHash: proposal.contentHash,
        totalBytes: proposal.totalBytes,
      })
    },
    snapshot() {
      const { active, bundle } = readActiveRecord(controlPlane, maxBundleBytes)
      return deepFreeze({
        status: 'active',
        epoch: active.epoch,
        identityVersion: bundle.identityVersion,
        contentHash: bundle.contentHash,
        totalBytes: bundle.totalBytes,
        activatedAt: active.activatedAt,
        activatedBy: active.activatedBy,
      })
    },
    identitySource(trustedContext) {
      const actor = requireActor(resolveActor, trustedContext)
      const { active, bundle } = readActiveRecord(controlPlane, maxBundleBytes)
      const roleFile = identityRoleFile(actor, bundle.manifest)
      const content = '[team identity update] ' + bundle.identityVersion + '\n'
        + bundle.texts['AGENTS.md'] + '\n\n' + bundle.texts[roleFile]
      return deepFreeze({
        id: 'identity:' + actor.name,
        revision: bundle.identityVersion + ':' + active.epoch + ':' + bundle.contentHash,
        content,
        priority: 0,
        required: true,
        safetyCritical: true,
        metadata: {
          identityVersion: bundle.identityVersion,
          roleFile,
          contentHash: bundle.contentHash,
          identityEpoch: active.epoch,
        },
      })
    },
  })

  const activate = async (input, trustedContext) => {
    const { expectedControlRevision, expectedIdentityEpoch, expectedBundleHash } = assertCasInput(input)
    const submittedActor = requireActor(resolveActor, trustedContext)
    const submittedActorKey = actorKey(submittedActor)
    const actorId = String(submittedActor.id ?? submittedActor.name)
    const committedBundleHash = { value: null }

    const result = await controlPlane.mutateHot(
      'identity/activated',
      { expectedControlRevision, expectedIdentityEpoch, expectedBundleHash },
      { id: actorId },
      (state) => {
        if (Number(state.revision) !== expectedControlRevision) fail('IDENTITY_CONTROL_REVISION_STALE')
        const currentEpoch = getEpoch(state)
        if (currentEpoch !== expectedIdentityEpoch) fail('IDENTITY_EPOCH_STALE')
        if (currentEpoch >= Number.MAX_SAFE_INTEGER) fail('IDENTITY_EPOCH_EXHAUSTED')

        const actor = requireActor(resolveActor, trustedContext)
        if (actorKey(actor) !== submittedActorKey) fail('IDENTITY_ACTOR_CHANGED')
        const disk = readDiskBundle()
        if (disk.contentHash !== expectedBundleHash) fail('IDENTITY_PROPOSAL_STALE')
        requireRootActor(actor, disk.manifest)
        const bundle = encodeBundle(disk.files, disk)
        const nextEpoch = currentEpoch + 1
        committedBundleHash.value = bundle.contentHash
        state.identityEpoch = nextEpoch
        state.activeIdentity = deepFreeze({
          status: 'active',
          epoch: nextEpoch,
          activatedAt: Date.now(),
          activatedBy: actorId,
          bundle,
        })
        return {
          status: 'active',
          epoch: nextEpoch,
          identityVersion: bundle.identityVersion,
          contentHash: bundle.contentHash,
          totalBytes: bundle.totalBytes,
        }
      },
      {
        deferMs: 0,
        afterDurable(_activation, durable) {
          if (Number(durable.identityEpoch) !== expectedIdentityEpoch + 1
            || durable.activeIdentity?.epoch !== expectedIdentityEpoch + 1
            || durable.activeIdentity?.status !== 'active') {
            fail('ACTIVE_IDENTITY_DURABLE_READBACK_MISMATCH')
          }
          const durableBundle = decodeStoredBundle(durable.activeIdentity.bundle, maxBundleBytes)
          if (durableBundle.contentHash !== committedBundleHash.value) {
            fail('ACTIVE_IDENTITY_DURABLE_READBACK_MISMATCH')
          }
          // Proposal files are no longer authoritative after publication.
        },
      },
    )
    return deepFreeze({ ...result, controlRevision: expectedControlRevision + 1 })
  }

  return Object.freeze({
    readonly,
    internal: Object.freeze({ activate }),
  })
}
