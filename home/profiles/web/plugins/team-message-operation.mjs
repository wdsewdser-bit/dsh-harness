import { hashControlValue } from './team-control-plane.mjs'
const activeOperations = globalThis[Symbol.for('dsh.team.messageOperations.active.v2')] ??= new Map()

export function messageOperationIdentity(input) {
  const operationId = String(input.operationId ?? '').trim()
  if (!operationId || operationId.length > 200) throw new Error('operation_id must contain 1 through 200 characters')
  const scope = { sender: input.sender, target: input.target, taskId: input.taskSnapshot?.taskId ?? null,
    taskRevision: input.taskSnapshot?.revision ?? null, event: operationId, delivery: input.delivery }
  return { ...scope, operationId, sender: input.sender, key: hashControlValue(scope), payloadHash: hashControlValue(input.payload), taskSnapshot: input.taskSnapshot }
}

/** Reserve before effects. An interrupted external delivery is never replayed on faith. */
export async function runMessageOperation(control, input, actor, execute) {
  if (input === undefined) return execute(async () => {}, undefined)
  const activeKey = control.file + ':' + input.key
  const receiptFor = (row, duplicate) => ({ ...row.receipt, operationId: input.operationId,
    duplicate, partial: row.status !== 'completed', operationRevision: row.revision })
  const pending = activeOperations.get(activeKey)
  if (pending !== undefined) {
    if (input.recovery !== undefined) throw new Error('message-operation-inflight: cannot recover a currently executing operation')
    await pending
    const row = control.messageOperationGet(input.key)
    if (!row) return runMessageOperation(control, input, actor, execute)
    if (row.payloadHash !== input.payloadHash) throw new Error('message-operation-conflict: changed payload; existing receipt=' + JSON.stringify(row.receipt))
    return receiptFor(row, true)
  }
  // Acquire synchronously before either durable recovery or reservation can await.
  let release
  activeOperations.set(activeKey, new Promise((resolve) => { release = resolve }))
  try {
    if (input.recovery !== undefined) await control.messageOperationRecover(input, actor)
    const begun = await control.messageOperationBegin(input, actor)
    if (!begun.claimed) return receiptFor(begun.operation, true)
    const checkpoint = async (receipt) => control.messageOperationUpdate({ key: input.key, payloadHash: input.payloadHash, receipt }, actor)
    try {
      const receipt = await execute(checkpoint, input.key, begun.operation.receipt)
      await control.messageOperationUpdate({ key: input.key, payloadHash: input.payloadHash, receipt, status: 'completed' }, actor)
      return receiptFor(control.messageOperationGet(input.key), false)
    } catch (error) {
      const current = control.messageOperationGet(input.key)
      const receipt = { ...current.receipt, status: 'delivery-failed', error: String(error?.message ?? error) }
      await control.messageOperationUpdate({ key: input.key, payloadHash: input.payloadHash, receipt, status: 'partial-failed' }, actor)
      return receiptFor(control.messageOperationGet(input.key), false)
    }
  } finally {
    activeOperations.delete(activeKey)
    release()
  }
}
