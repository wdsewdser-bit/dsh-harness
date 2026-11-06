// A real child process for the multi-process ownership tests: it takes the OS lock, reports the outcome as one JSON
// line on stdout, and (in 'hold' mode) stays alive until the parent kills it. Nothing here simulates the lock.
import { acquireOwnership } from '../index.mjs';

const mode = process.argv[2];
const root = process.argv[3];
const startAt = Number(process.argv[4] ?? 0);
const holdMs = Number(process.argv[5] ?? 0);

function report(value) {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...value }) + '\n');
}

async function main() {
  const wait = startAt - Date.now();
  if (Number.isFinite(wait) && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  let handle;
  try {
    handle = await acquireOwnership({ root });
  } catch (error) {
    report({ ok: false, code: error.code ?? 'ERROR', message: error.message });
    process.exitCode = 1;
    return;
  }
  report({ ok: true, epoch: handle.epoch, kind: handle.kind });
  if (mode === 'hold') {
    // Stay alive holding the OS name until the parent kills this process; the kernel then drops the name.
    setInterval(() => {}, 1000);
    return;
  }
  await new Promise(resolve => setTimeout(resolve, holdMs));
  await handle.release();
}

await main();
