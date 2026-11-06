import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProcessIdentity } from './process-tree.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-timeout-'));
if (process.env.BORROW_WORKER_PID_FILE) writeProcessIdentity(process.env.BORROW_WORKER_PID_FILE);
if (process.env.BORROW_TIMEOUT_READY) fs.writeFileSync(process.env.BORROW_TIMEOUT_READY,
  JSON.stringify({ pid: process.pid, dir }));
setInterval(() => {}, 1000);
