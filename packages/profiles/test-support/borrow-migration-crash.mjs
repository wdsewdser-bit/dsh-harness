import { writeProcessIdentity } from './process-tree.mjs';
import { migrateBorrowPolicy } from '../index.mjs';
if (process.env.BORROW_WORKER_PID_FILE) writeProcessIdentity(process.env.BORROW_WORKER_PID_FILE);
const [root,teamId,to,point,operationId] = process.argv.slice(2);
await migrateBorrowPolicy({ root,teamId,to,operationId,reason:'crash acceptance',
  verifyQuiescence: facts => ({ ...facts, terminated:true, evidenceRef:'external:verified-stop' }),
  hooks: { [point]: () => process.exit(71) } });
throw Error('crash point was not reached');
