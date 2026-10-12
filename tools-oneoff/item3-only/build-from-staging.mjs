import fs from 'node:fs'
const [stage, out] = process.argv.slice(2)
let text = fs.readFileSync(stage, 'utf8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const swap = (from, to) => { if (text.split(from).length !== 2) throw new Error('NOT_ONCE ' + from.slice(0, 50)); text = text.replace(from, to) }
swap('registerDeliveryService, deliveryPlanRequired }', 'registerDeliveryService }')
swap("  const requiresPlan = () => deliveryPlanRequired(agent) || (Number(member()?.tier) === 0 && config.deliveryPolicy?.requirePlan === true)" + eol, '')
swap('collectContext: collectDelivery, requiresPlan, agent })', 'collectContext: collectDelivery })')
swap("      required: () => requiresPlan() || Object.keys(readDeliveryState().v15PlanDelivery?.plans ?? {}).length > 0, requiresPlan }) : undefined" + eol
  + "  if (requiresPlan() && !goalGate) refuse('GOAL_DELIVERY_BRIDGE_UNAVAILABLE', 'strict delivery requires the native completion gate')" + eol,
  "      required: () => Object.keys(readDeliveryState().v15PlanDelivery?.plans ?? {}).length > 0 }) : undefined" + eol)
fs.writeFileSync(out, text)
