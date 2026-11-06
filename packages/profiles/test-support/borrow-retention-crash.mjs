import { writeProcessIdentity } from './process-tree.mjs';
import { ControlStore } from '../../store/index.mjs';

// Real crash cut point for the authoritative-evidence compactor: this process exits inside ControlStore.retainEvidence,
// with no close, no cleanup and no chance to compensate. The parent reopens the store and proves that the transaction
// boundary - not a compensating step - is what keeps archive and deletion together.
if (process.env.BORROW_WORKER_PID_FILE) writeProcessIdentity(process.env.BORROW_WORKER_PID_FILE);
const [root, point] = process.argv.slice(2);
if (!['beforeCommit', 'afterCommit'].includes(point)) throw Error('unknown crash point: ' + point);
const store = new ControlStore(root, { [point]: () => process.exit(71) });
store.retainEvidence({ now: 1800000000000, limits: { deliveries: 1, outcomes: 1, audits: 1, decisions: 1, outbox: 1, receipts: 2 } });
store.close();
throw Error('retention crash point was not reached');
