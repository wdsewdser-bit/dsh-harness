/** Additive v1 read contract, not a write/authorization schema. */
export const certificateBindingSchema = Object.freeze({
 type:'object',additionalProperties:false,
 required:['certificateHash','taskId','verifier','contractRevision','candidate','tree','deliveryId','deliveryRevision','status'],
 properties:{certificateHash:{type:'string',pattern:'^[a-f0-9]{64}$'},taskId:{type:'string'},attemptId:{type:'string'},verifier:{type:'string'},contractRevision:{type:'integer',minimum:1},candidate:{type:'string'},tree:{type:'string'},deliveryId:{type:'string'},deliveryRevision:{type:'integer',minimum:1},status:{type:'string'}}
});

/**
 * P5 (§3.2, §10 P5): the v1 read shapes.
 *
 * These are additive consumer contracts. They describe what the projection may publish once the protocol is on; they
 * never authorize a write. A resource thread is its own collection beside decision threads, so a consumer that only
 * knows requiredRespondents cannot receive one by accident.
 */
export const resourceThreadSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'status', 'owner', 'resource', 'head', 'retainedFrom', 'subscribers', 'lastEvent', 'revision'],
  properties: {
    id: { type: 'string' }, threadRef: { type: 'string' }, kind: { const: 'resource' },
    status: { enum: ['open', 'closed'] }, owner: { type: 'string' },
    resource: { type: 'object', additionalProperties: false, required: ['kind', 'repositoryKey', 'key'],
      properties: { kind: { enum: ['branch', 'pr', 'file-area'] }, repositoryKey: { type: 'string' }, key: {} } },
    head: { type: 'integer', minimum: 0 }, retainedFrom: { type: 'integer', minimum: 1 },
    pending: { type: 'integer', minimum: 0 }, descriptionRef: { type: ['string', 'null'] },
    subscribers: { type: 'array', items: { type: 'object', required: ['memberId', 'generation', 'subscriptionEpoch', 'state', 'pending'],
      properties: { memberId: { type: 'string' }, generation: { type: 'integer' }, subscriptionEpoch: { type: 'integer' },
        state: { enum: ['active', 'paused', 'closed'] }, startAfterSeq: { type: 'integer' }, visibleThrough: { type: 'integer' },
        pending: { type: 'integer', minimum: 0 } } } },
    lastEvent: { type: ['object', 'null'] }, revision: { type: 'integer', minimum: 1 },
  },
});

export const capacityStatusSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['normal', 'human', 'unknown', 'admissionClosed', 'providerCapacity', 'providerWait',
    'providerRetryAfterMs', 'providerRecoveryAt'],
  properties: {
    normal: { type: 'object', required: ['current', 'limit'], properties: { current: { type: 'integer' }, limit: { type: ['integer', 'null'] },
      unknown: { type: 'integer' }, queued: { type: 'integer' }, oldestAge: { type: ['integer', 'null'] } } },
    human: { type: 'object', required: ['current', 'limit'], properties: { current: { type: 'integer' }, limit: { const: 1 },
      unknown: { type: 'integer' }, queued: { type: 'integer' }, oldestAge: { type: ['integer', 'null'] } } },
    unknown: { type: 'integer', minimum: 0 }, admissionClosed: { type: 'boolean' },
    queued: { type: 'integer' }, oldestAge: { type: ['integer', 'null'] },
    blocked: { type: 'array' }, occupants: { type: 'array' },
    // Gap 3: an observed provider state, never an assumed one. Only a real response can say 'available'.
    providerCapacity: { enum: ['unknown', 'available', 'throttled'] },
    providerWait: { enum: ['none', 'local-queued', 'provider-throttled'] },
    providerRetryAfterMs: { type: ['integer', 'null'], minimum: 0 }, providerRecoveryAt: { type: ['integer', 'null'] },
  },
});

export const roleGuardStatusSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['coordinatorOnly', 'policy', 'denials', 'allows', 'audit'],
  properties: {
    coordinatorOnly: { const: true },
    policy: { type: 'object', required: ['deny', 'allow', 'unknown'] },
    installed: { type: ['boolean', 'null'] }, revoked: { type: ['boolean', 'null'] },
    denials: { type: 'integer', minimum: 0 }, allows: { type: 'integer', minimum: 0 },
    auditPersistFailed: { type: ['boolean', 'null'] }, declared: { type: ['array', 'null'] },
    audit: { type: 'object', required: ['denied', 'allowed'], properties: { denied: { type: 'integer' },
      allowed: { type: 'integer' }, byTool: { type: ['array', 'null'] } } },
  },
});

export const inputBatchSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['batches', 'latest', 'count'],
  properties: {
    count: { type: 'integer', minimum: 0 }, latest: { type: ['object', 'null'] },
    batches: { type: 'array', items: { type: 'object', required: ['id', 'memberId', 'items'],
      properties: { id: { type: 'string' }, memberId: { type: ['string', 'null'] }, generation: { type: ['integer', 'null'] },
        cutoffSeq: { type: ['integer', 'null'] }, items: { type: 'integer', minimum: 0 },
        pendingCount: { type: ['integer', 'null'] }, omittedCount: { type: ['integer', 'null'] },
        nextCursor: { type: ['integer', 'null'] }, injectedAt: { type: ['integer', 'null'] },
        revision: { type: ['integer', 'null'] } } } },
  },
});
