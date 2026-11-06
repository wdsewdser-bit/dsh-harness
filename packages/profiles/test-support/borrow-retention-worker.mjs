import { writeProcessIdentity } from './process-tree.mjs';
import { ControlStore } from '../../store/index.mjs';

// Concurrent retention worker: two real processes contend for the same store's write lock. The pass must be atomic
// under contention: either it applies (archive + deletion + compaction together) or it fails closed and leaves the
// database exactly as it was, with the original error code reaching this process.
if (process.env.BORROW_WORKER_PID_FILE) writeProcessIdentity(process.env.BORROW_WORKER_PID_FILE);
const [root, label] = process.argv.slice(2);
const store = new ControlStore(root);
try {
  const result = store.retainEvidence({ limits: { deliveries: 1, receipts: 2 } });
  process.stdout.write(JSON.stringify({ label, ok: true, inserted: result.archive.inserted }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ label, ok: false, code: error.code ?? null, message: error.message }) + '\n');
  process.exitCode = 3;
} finally {
  store.close();
}
