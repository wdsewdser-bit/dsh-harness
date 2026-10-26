import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = row => digest([row.sender, row.operationId])
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined
const copy = value => value === undefined ? undefined : structuredClone(value)
const pending = row => row && !['handled', 'rejected'].includes(row.status)

export function ensureInboxIndex(state, readCold) {
  if (state.inboxPendingIndex?.version === 1) return
  const refs = state.coldHistory ?? {}
  const rows = { ...(refs.inboxBatch ? readCold(refs.inboxBatch) : {}) }
  for (const [id, ref] of Object.entries(refs.inbox ?? {})) rows[id] = readCold(ref)
  Object.assign(rows, state.v12RoomWake?.inbox ?? {})
  state.inboxPendingIndex = { version: 1, targets: {} }
  for (const [id, row] of Object.entries(rows)) {
    if (!Object.hasOwn(state.v12RoomWake?.acknowledgedInbox ?? {}, id)) putInbox(state.inboxPendingIndex, id, row)
  }
}

function putInbox(index, id, row) {
  if (!pending(row)) return
  const target = String(row.target ?? '')
  const status = String(row.status ?? '')
  const targets = index.targets
  if (!Object.hasOwn(targets, target)) Object.defineProperty(targets, target, { value: {}, enumerable: true, writable: true, configurable: true })
  const statuses = targets[target]
  if (!Object.hasOwn(statuses, status)) Object.defineProperty(statuses, status, { value: {}, enumerable: true, writable: true, configurable: true })
  Object.defineProperty(statuses[status], id, { value: copy(row), enumerable: true, writable: true, configurable: true })
}

export function captureInbox(state, readCold) {
  ensureInboxIndex(state, readCold)
  // Mutations such as inbox_ack must also see pending rows older than the
  // bounded history/panel window. Reads can continue to use the target index.
  state.v12RoomWake ??= {}
  state.v12RoomWake.inbox ??= {}
  for (const statuses of Object.values(state.inboxPendingIndex.targets)) {
    for (const rows of Object.values(statuses)) for (const [id, row] of Object.entries(rows)) {
      if (!Object.hasOwn(state.v12RoomWake.inbox, id)) Object.defineProperty(state.v12RoomWake.inbox, id, {
        value: copy(row), enumerable: true, writable: true, configurable: true,
      })
    }
  }
  return new Map(Object.entries(state.v12RoomWake?.inbox ?? {}).map(([id, row]) => [id, { row: copy(row), signature: JSON.stringify(row) }]))
}

export function updateInboxIndex(state, before) {
  const index = state.inboxPendingIndex
  const after = state.v12RoomWake?.inbox ?? {}
  const remove = (id, row) => {
    const statuses = own(index.targets, String(row?.target ?? ''))
    for (const rows of Object.values(statuses ?? {})) delete rows[id]
  }
  for (const [id, previous] of before) {
    if (!Object.hasOwn(after, id) || JSON.stringify(after[id]) !== previous.signature) remove(id, previous.row)
  }
  for (const [id, row] of Object.entries(after)) {
    if (JSON.stringify(row) !== before.get(id)?.signature) putInbox(index, id, row)
  }
  for (const [id, row] of Object.entries(state.v12RoomWake?.acknowledgedInbox ?? {})) {
    // Acknowledgment carriers may retire the hot row entirely.
    remove(id, row)
  }
}

export function queryInbox(state, target, nativeIds = []) {
  const native = new Set(nativeIds)
  const statuses = own(state.inboxPendingIndex?.targets, String(target)) ?? {}
  return Object.values(statuses).flatMap(rows => Object.values(rows))
    .filter(row => pending(row) && row.target === target && !native.has(row.messageId)).map(copy)
}

function manifest(state) {
  if (state.messageOperationArchive === undefined) return undefined
  const value = state.messageOperationArchive
  if (value?.version !== 1) throw new Error('control-plane cold operation manifest invalid')
  for (const type of ['keys', 'identities']) {
    const refs = value[type]
    if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 256) throw new Error('control-plane cold operation manifest invalid')
    for (const [shard, ref] of Object.entries(refs)) if (!/^[a-f0-9]{2}$/.test(shard) || !/^[a-f0-9]{64}$/.test(ref)) throw new Error('control-plane cold operation reference invalid')
  }
  return value
}

function shardRead(state, type, key, readCold) {
  const ref = manifest(state)?.[type]?.[digest(key).slice(0, 2)]
  if (!ref) return {}
  const value = readCold(ref)
  if (!value || value.version !== 1 || value.type !== type || !value.rows || typeof value.rows !== 'object' || Array.isArray(value.rows)) throw new Error('control-plane cold operation shard invalid')
  return value.rows
}

export function operationGet(state, key, readCold) {
  const hot = own(state.messageOperations, key)
  if (hot) return hot
  const row = own(shardRead(state, 'keys', key, readCold), key)
  if (row && (row.key !== key || row.status !== 'completed')) throw new Error('control-plane cold operation receipt invalid')
  return row
}

function hotIndex(state) {
  if (state.messageOperationHotIndex?.version === 1) return state.messageOperationHotIndex.rows
  const rows = {}
  for (const row of Object.values(state.messageOperations ?? {})) rows[identity(row)] = row.key
  state.messageOperationHotIndex = { version: 1, rows }
  return rows
}

export function operationFind(state, input, readCold) {
  const id = identity(input)
  const key = hotIndex(state)[id] ?? own(shardRead(state, 'identities', id, readCold), id)
  if (key === undefined) return undefined
  const row = operationGet(state, key, readCold)
  if (!row || row.sender !== input.sender || row.operationId !== input.operationId) throw new Error('control-plane cold operation identity missing or corrupt')
  return row
}

export function operationRemember(state, row) {
  hotIndex(state)[identity(row)] = row.key
}

export function archiveOperations(state, readCold, writeCold, config = {}) {
  const requested = Number(config.messageOperationHotLimit ?? 1024)
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(10000, Math.floor(requested))) : 1024
  const entries = Object.entries(state.messageOperations ?? {})
  if (entries.length <= limit) return false
  const eligible = entries.filter(([, row]) => row.status === 'completed'
    && (row.receipt?.externalAttempted === false || row.receipt?.externalConfirmed === true))
  const selected = eligible.slice(0, Math.max(0, entries.length - limit))
  const prior = manifest(state)
  const next = { version: 1, keys: { ...(prior?.keys ?? {}) }, identities: { ...(prior?.identities ?? {}) } }
  // Construct immutable shards first; only a successful snapshot makes them authoritative.
  for (const type of ['keys', 'identities']) {
    const groups = new Map()
    for (const [key, row] of selected) {
      const lookup = type === 'keys' ? key : identity(row)
      const shard = digest(lookup).slice(0, 2)
      if (!groups.has(shard)) groups.set(shard, { ...shardRead(state, type, lookup, readCold) })
      groups.get(shard)[lookup] = type === 'keys' ? copy(row) : key
    }
    for (const [shard, rows] of groups) next[type][shard] = writeCold({ version: 1, type, rows })
  }
  state.messageOperationArchive = next
  for (const [key] of selected) delete state.messageOperations[key]
  delete state.messageOperationHotIndex
  hotIndex(state)
  state.messageOperationLifecycle = { version: 1, hotLimit: limit, hotCount: entries.length - selected.length,
    archivedCount: Number(state.messageOperationLifecycle?.archivedCount ?? 0) + selected.length,
    retainedUnsafe: entries.length - eligible.length, overLimit: entries.length - selected.length > limit }
  return selected.length > 0
}
