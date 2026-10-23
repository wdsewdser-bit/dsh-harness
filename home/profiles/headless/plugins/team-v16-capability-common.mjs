import { createHash } from 'node:crypto'
export const fail = code => { throw Object.assign(new Error(code), { code }) }
// Reject values JSON.stringify would silently alter, including accessors and sparse arrays.
export function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value)
  if (!value || typeof value !== 'object' || seen.has(value)) fail('CAPABILITY_LOSSLESS_JSON_REQUIRED')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('CAPABILITY_LOSSLESS_JSON_REQUIRED')
  seen.add(value)
  const keys = Reflect.ownKeys(value).filter(k => !(Array.isArray(value) && k === 'length'))
  if (keys.some(k => typeof k !== 'string' || !Object.getOwnPropertyDescriptor(value, k)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) fail('CAPABILITY_LOSSLESS_JSON_REQUIRED')
  let text
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((k, i) => k !== String(i))) fail('CAPABILITY_LOSSLESS_JSON_REQUIRED')
    text = '[' + value.map(v => canonical(v, seen)).join(',') + ']'
  } else text = '{' + keys.sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], seen)).join(',') + '}'
  seen.delete(value)
  return text
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export const clone = value => { canonical(value); return JSON.parse(JSON.stringify(value)) }
export function binding(ctx, agent, resolver) {
  const member = ctx.agentTeams?.tryMembership(agent)
  const extra = typeof resolver === 'function' ? resolver(agent) : null
  if (!agent?.session?.id || !member?.id || !member?.name || !extra || extra.then) fail('CAPABILITY_ACTOR_DENIED')
  const result = { team: member.id, member: member.name, session: agent.session.id,
    role: extra.role, workspace: extra.workspace, task: extra.task, taskRevision: extra.taskRevision,
    plan: extra.plan, planRevision: extra.planRevision }
  if (Object.values(result).some(v => v === undefined || v === null || v === '')) fail('CAPABILITY_BINDING_REQUIRED')
  if (extra.authority !== undefined) result.authority = clone(extra.authority)
  if (extra.authority !== undefined) result.authority = clone(extra.authority)
  return clone(result)
}
