import { goalFixture } from './native-goal-fixture.mjs'
const f = await goalFixture(process.argv[2], { native: false })
f.failAck(true)
try { await f.current.goals.complete(f.current.agent, f.ref) }
catch (error) { if (error.code !== 'ACK_FAILURE') throw error }
process.exit(19)
